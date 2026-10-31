// `onememory watch`: react to changes the moment they land.
//
// A long-poll loop over the local store (the same live wait the API uses):
// parked at no cost until something changes in scope, then it prints the
// changes and, with --exec, runs a program of YOUR choosing once per batch.
//
// Safety: the program is started with execFile (shell:false) -- the program
// name and each argument are passed as an argv array exactly as typed, never
// joined into a shell string, and the change data goes in on stdin as JSON
// (titles are untrusted text; they are never placed in argv or the shell).
// The marker uses manual acks: it moves only after the program exits 0, so a
// crash or a failing handler gets the same batch again (after a pause).
import { execFile } from "node:child_process";
import type { Store } from "./store.js";
import { waitForChanges } from "./change-wait.js";
import { ackChanges, type ChangesResponse } from "./changes.js";

export interface WatchOpts {
  consumer: string;
  waitSeconds: number;
  namespaces?: string[];
  /** Writer / trust filters (same meaning as on memory_since). */
  filter?: { writtenBy?: string; notWrittenBy?: string; noteWrittenBy?: string; notNoteWrittenBy?: string; includeDistrusted?: boolean };
  /** Program + args to run per batch (no shell). */
  exec?: string[];
  signal?: AbortSignal;
  /** Output sink (default console.log). */
  log?: (line: string) => void;
  /** Pause after a failing handler before the batch is retried. */
  retryMs?: number;
  /** Give up (throw) after this many failures in a row, a failed wait or a failing handler (default 10): fail loudly, never loop. */
  maxFailures?: number;
  /** Test seam: stop after this many batches. */
  maxBatches?: number;
  /** Test seam: replace the process runner. Resolves the exit code. */
  run?: (argv: string[], stdin: string, env: Record<string, string>, signal?: AbortSignal) => Promise<number>;
}

function runProgram(argv: string[], stdin: string, env: Record<string, string>, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      { shell: false, windowsHide: true, timeout: 120_000, signal, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
      (err) => resolve(err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0)
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export async function watchLoop(store: Store, opts: WatchOpts): Promise<number> {
  // The live wait's timers are unref'd (a server must not be kept alive by a
  // parked request), so in a bare CLI process nothing else holds the event
  // loop open and `watch` would exit at once. This ref'd timer is what keeps it running.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    return await watchLoopInner(store, opts);
  } finally {
    clearInterval(keepAlive);
  }
}

async function watchLoopInner(store: Store, opts: WatchOpts): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const run = opts.run ?? runProgram;
  let batches = 0;
  let failures = 0;
  const failed = async (what: string): Promise<void> => {
    if (++failures >= (opts.maxFailures ?? 10)) throw new Error(`watch: giving up after ${failures} failures in a row (last: ${what}); fix it and start watch again`);
    await sleep(opts.retryMs ?? 5000, opts.signal);
  };
  while (!opts.signal?.aborted && (opts.maxBatches === undefined || batches < opts.maxBatches)) {
    let out: ChangesResponse;
    try {
      out = await waitForChanges(
        store,
        { since: "last", consumer: opts.consumer, namespaces: opts.namespaces, ackMode: "manual", excludeSelf: true, ...(opts.filter ?? {}) },
        { waitSeconds: opts.waitSeconds, signal: opts.signal, key: "cli-watch" }
      );
    } catch (e) {
      log(`watch: ${(e as Error).message}`);
      await failed((e as Error).message);
      continue;
    }
    if (out.changes.length === 0) {
      // Nothing for us, but the window moved: keep the marker current.
      failures = 0;
      if (out.ack_token) ackChanges(store, { ackToken: out.ack_token, consumer: opts.consumer, namespaces: opts.namespaces, ...(opts.filter ?? {}) });
      continue;
    }
    for (const c of out.changes) {
      log(`${c.kind === "created" ? "+" : c.kind === "updated" ? "~" : "-"} #${c.id} [${c.namespace}] ${c.title}  (${c.at}${c.source ? `, ${c.source}` : ""})`);
    }
    let ok = true;
    if (opts.exec && opts.exec.length) {
      const code = await run(
        opts.exec,
        JSON.stringify({ consumer: opts.consumer, changes: out.changes, counts: out.counts }),
        { ONEMEMORY_CHANGE_COUNT: String(out.changes.length), ONEMEMORY_CONSUMER: opts.consumer },
        opts.signal
      );
      ok = code === 0;
      if (!ok && opts.signal?.aborted) {
        // Stopped by a signal: the handler was killed, the batch is not acked
        // and will be delivered again next time. No retry pause.
        log("watch: stopped; the interrupted batch will be delivered again next time");
        break;
      }
      if (!ok) log(`watch: handler exited ${code}; the same changes will be delivered again`);
    }
    if (ok && out.ack_token) ackChanges(store, { ackToken: out.ack_token, consumer: opts.consumer, namespaces: opts.namespaces, ...(opts.filter ?? {}) });
    batches++;
    if (ok) failures = 0;
    else await failed("the handler failed");
  }
  return batches;
}
