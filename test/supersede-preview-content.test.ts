// The preview must show what would be lost: the old note's real text, writer, dates and tag, plus what is NOT lost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore } from "../src/actor.js";
import { supersedeCli, type CliIO } from "../src/supersede-cli.js";

const BODY = "The staging server password rotates every Thursday at noon";
const TOKEN = "w-token-0123456789abcdef";
const today = new Date().toISOString().slice(0, 10);

function assertShowsWhatIsLost(w: string, id: number): void {
  assert.match(w, /ARE YOU SURE YOU WANT TO REPLACE THIS\?/);
  assert.ok(w.includes(`Note ${id}: "Rotation rule"`), "title");
  assert.ok(w.includes(`Says: "${BODY}"`), "the old note's real text must be in Says");
  assert.match(w, /[Ww]ritten by "alice"/, "writer");
  assert.ok(w.includes(`first saved ${today}`), "created date");
  assert.ok(w.includes(`last changed ${today}`), "changed date");
  assert.ok(w.includes('Tags: "ops-secret"'), "tag");
  assert.match(w, /WHAT YOU DO NOT LOSE:/);
  assert.match(w, /Nothing is deleted\. The old note keeps its full text, its writer, its dates and its tags/);
  assert.match(w, /WHAT YOU LOSE:/);
}

describe("preview shows what would be lost", () => {
  test("REST", async () => {
    const store = new Store(":memory:");
    const srv: Server = createApiServer(store, [{ token: TOKEN, scope: "write", label: "alice", namespace: "t" }]);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      const made = await (await fetch(base + "/notes", { method: "POST", headers: h, body: JSON.stringify({ title: "Rotation rule", body: BODY, tags: ["ops-secret"] }) })).json();
      const id = made.note.id;
      const p = await (await fetch(base + "/supersede/preview", { method: "POST", headers: h, body: JSON.stringify({ old_ids: [id], new_note: { title: "Rotation rule", body: "Rotates on Monday" } }) })).json();
      assertShowsWhatIsLost(p.warning, id);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
      store.close();
    }
  });

  test("MCP", async () => {
    const store = new Store(":memory:");
    try {
      const server = createMcpServer(store, "write", {} as never, { label: "alice", authed: true });
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c), server.connect(s)]);
      const wr = (await client.callTool({ name: "state_write", arguments: { title: "Rotation rule", body: BODY, tags: ["ops-secret"] } })) as any;
      const t0 = wr.content[0].text as string;
      const id = JSON.parse(t0.slice(t0.indexOf("{"))).note.id;
      const p = (await client.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [id], new_title: "Rotation rule", new_body: "Rotates on Monday" } })) as any;
      assertShowsWhatIsLost(p.content[0].text, id);
      await client.close();
    } finally {
      store.close();
    }
  });

  test("command line (readable text, not --json)", async () => {
    const store = new Store(":memory:");
    try {
      const old = actorStore.run({ label: "alice", authed: true }, () => store.create({ title: "Rotation rule", body: BODY, tags: ["ops-secret"] }));
      const out: string[] = [];
      const io: CliIO = { out: (x) => out.push(x), err: () => {}, interactive: false, ask: async () => "" };
      const code = await supersedeCli(store, ["--old", String(old.id), "--title", "Rotation rule", "--body", "Rotates on Monday"], io);
      assert.equal(code, 2);
      assertShowsWhatIsLost(out.join("\n"), old.id);
    } finally {
      store.close();
    }
  });

  test("the previewed text also shows when the old note has no tags and a long body is cut with its full length stated", async () => {
    const store = new Store(":memory:");
    try {
      const long = "x".repeat(1000);
      const old = actorStore.run({ label: "alice", authed: true }, () => store.create({ title: "Long", body: long }));
      const out: string[] = [];
      const io: CliIO = { out: (x) => out.push(x), err: () => {}, interactive: false, ask: async () => "" };
      await supersedeCli(store, ["--old", String(old.id), "--title", "Long", "--body", "short"], io);
      const w = out.join("\n");
      assert.match(w, /Tags: none\./);
      assert.match(w, /\(1000 characters in all\)/);
    } finally {
      store.close();
    }
  });
});
