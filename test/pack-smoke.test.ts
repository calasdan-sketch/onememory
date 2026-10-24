// The published tarball must actually start. The unit tests run from the repo's
// dist/, which has every file; the package.json `files` list does not (it
// leaves out the runner). In 1.3.4 development a module the server needs was
// named runner-status.js and matched the runner exclusion, so `npm pack`
// silently dropped it and the installed package crashed on start. This test
// packs the project, unpacks the tarball into a temp folder, and runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";

/**
 * Extract a .tgz with Node alone (no `tar` binary: Windows images and minimal containers do not all have
 * one). Handles what `npm pack` writes: ustar entries with a name prefix, and pax `path` overrides.
 */
function untarGz(file: string, outDir: string): void {
  const buf = gunzipSync(readFileSync(file));
  const field = (o: number, n: number): string => {
    const raw = buf.subarray(o, o + n);
    const z = raw.indexOf(0);
    return raw.subarray(0, z < 0 ? n : z).toString("utf8");
  };
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    let name = field(off, 100);
    const size = parseInt(field(off + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = field(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "g") continue;
    if (paxPath) {
      name = paxPath;
      paxPath = null;
    }
    if (type !== "0" && type !== "\0") continue; // directories are created on demand
    const target = resolve(outDir, name);
    if (!target.startsWith(resolve(outDir))) throw new Error(`unsafe path in tarball: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function packAndExtract(root: string): string {
  const npmCli = process.env.npm_execpath;
  const [cmd, pre] = npmCli ? [process.execPath, [npmCli]] : ["npm", []];
  const dest = join(root, "tgz");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(dest)})`]);
  execFileSync(cmd, [...pre, "pack", "--ignore-scripts", "--pack-destination", dest], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  assert.ok(tgz, "npm pack produced a tarball");
  const out = join(root, "x");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(out)})`]);
  untarGz(join(dest, tgz), out);
  const pkg = join(out, "package");
  assert.ok(existsSync(join(pkg, "dist", "src", "cli.js")), "the tarball holds the CLI");
  // Nothing is installed: reuse the repo's dependencies.
  symlinkSync(join(PROJECT_ROOT, "node_modules"), join(pkg, "node_modules"), "junction");
  return pkg;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("the packed tarball starts: every relative import resolves, runner-status and the MCP server work", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-pack-"));
  try {
    const pkg = packAndExtract(root);

    // 1. No packed module may import a file that is not in the tarball.
    const src = join(pkg, "dist", "src");
    const missing: string[] = [];
    for (const f of walk(src).filter((p) => p.endsWith(".js"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = resolve(dirname(f), m[1]);
        if (!existsSync(target)) missing.push(`${f.slice(pkg.length + 1)} -> ${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], `packed files import files that are not in the tarball: ${missing.join("; ")}`);

    const home = join(root, "home");
    const env = { ...process.env, ONEMEMORY_HOME: home, ONEMEMORY_DB_PATH: join(home, "state.db"), HOME: home, USERPROFILE: home };

    // 2. The runner-status command (it loads the liveness module).
    const rs = spawnSync(process.execPath, [join(src, "cli.js"), "runner-status", "--json"], { cwd: pkg, env, encoding: "utf8", timeout: 60000 });
    assert.equal(rs.status, 0, `runner-status failed: ${rs.stderr}`);
    const j = JSON.parse(rs.stdout);
    assert.equal(j.runner.state, "never_seen");
    assert.equal(j.waiting_total, 0);

    // 3. The MCP stdio server answers tools/list (it imports the same module).
    const tools = await new Promise<string[]>((res, rej) => {
      const child = spawn(process.execPath, [join(src, "mcp-stdio.js")], { cwd: pkg, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        rej(new Error(`no tools/list answer in time. stderr: ${err.slice(0, 500)}`));
      }, 30000);
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", (d) => {
        out += d;
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2 && msg.result) {
              clearTimeout(timer);
              child.kill();
              res((msg.result.tools as Array<{ name: string }>).map((t) => t.name));
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.on("exit", (code) => {
        if (!out.includes('"id":2')) {
          clearTimeout(timer);
          rej(new Error(`mcp-stdio exited early (code ${code}). stderr: ${err.slice(0, 800)}`));
        }
      });
      const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pack-smoke", version: "1" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    });
    assert.ok(tools.includes("runner_status"), "runner_status is served by the packed server");
    assert.ok(tools.includes("state_write"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
