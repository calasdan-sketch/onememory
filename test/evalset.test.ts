// Retrieval evaluation set: "does memory actually help across surfaces?"
//
// Community feedback asked for "a small evaluation set of repeated
// cross-device tasks [that] could show whether it improves." This harness
// loads evals/cross-device-tasks.json, seeds a fresh store per task (so
// access-counter feedback from one query cannot leak into another's ranking,
// keeping every measurement independent and reproducible), runs each query,
// and scores retrieval with recall@1, recall@5 and MRR.
//
// It GATES on thresholds: a ranking, FTS, or schema change that quietly
// degrades retrieval fails CI instead of shipping. Access boost is disabled
// for the same determinism reason -- the eval measures native retrieval
// quality, not the rich-get-richer feedback loop.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type NoteRecord } from "../src/store.js";
import { runSearch, runRelevantSearch } from "../src/search-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Source layout: test/ -> repo root -> evals/. Runs from dist/test in CI, so
// walk up to the repo root (two levels) to find evals/ at runtime.
const EVAL_PATH = join(HERE, "..", "..", "evals", "cross-device-tasks.json");

interface EvalNote {
  title: string;
  body: string;
  tags: string[];
  written_from: string;
}
interface EvalTask {
  query: string;
  expected: string;
  why: string;
}
interface EvalSet {
  notes: EvalNote[];
  tasks: EvalTask[];
}

/** Minimum acceptable retrieval quality, measured BEST-OF-BOTH-PATHS.
 *
 * An agent has two retrieval tools: `state_search` (AND-conjunction keyword
 * search, precise but strict) and `state_relevant` (OR semantics, for vague
 * natural-language messages). "Can this memory be recalled?" is answered by
 * the best rank across both, which is the user-facing capability. The
 * keyword-only recall is REPORTED (not gated) so the AND-search limitation
 * stays visible instead of being papered over.
 */
const MIN_RECALL_AT_1 = 0.9;
const MIN_RECALL_AT_5 = 1.0; // every expected note must be findable in the top 5 of some path
const MIN_MRR = 0.92;

function loadEvalSet(): EvalSet {
  const raw = JSON.parse(readFileSync(EVAL_PATH, "utf8")) as EvalSet;
  assert.ok(Array.isArray(raw.notes) && raw.notes.length > 0, "eval set has notes");
  assert.ok(Array.isArray(raw.tasks) && raw.tasks.length > 0, "eval set has tasks");
  // Every task's expected title must exist in the seeded notes, or the eval
  // silently measures nothing.
  const titles = new Set(raw.notes.map((n) => n.title));
  for (const t of raw.tasks) {
    assert.ok(titles.has(t.expected), `task "${t.query}" expects missing note "${t.expected}"`);
  }
  return raw;
}

/** Seed a fresh, isolated store for one task. Returns it plus its temp dir. */
function seedStore(evalSet: EvalSet): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "om-eval-"));
  const savedKey = process.env.ONEMEMORY_KEY_FILE;
  const savedBoost = process.env.ONEMEMORY_ACCESS_BOOST;
  process.env.ONEMEMORY_KEY_FILE = join(dir, "no-such-key"); // plaintext store
  process.env.ONEMEMORY_ACCESS_BOOST = "0"; // deterministic: native ranking only
  const store = new Store(join(dir, "state.db"));
  for (const n of evalSet.notes) store.create({ title: n.title, body: n.body, tags: n.tags });
  // Restore env immediately; the Store captured its key state at open.
  if (savedKey === undefined) delete process.env.ONEMEMORY_KEY_FILE;
  else process.env.ONEMEMORY_KEY_FILE = savedKey;
  if (savedBoost === undefined) delete process.env.ONEMEMORY_ACCESS_BOOST;
  else process.env.ONEMEMORY_ACCESS_BOOST = savedBoost;
  return { store, dir };
}

describe("eval set: cross-device memory retrieval", () => {
  const evalSet = loadEvalSet();

  test("retrieval meets the quality gate (recall@1, recall@5, MRR)", async () => {
    let hitsAt1 = 0;
    let hitsAt5 = 0;
    let reciprocalRankSum = 0;
    let keywordHitsAt1 = 0;
    const misses: string[] = [];

    for (const task of evalSet.tasks) {
      const { store, dir } = seedStore(evalSet);
      try {
        // Path 1: keyword search (state_search) -- AND conjunction, precise.
        const keywordResults = await runSearch(store, task.query, { limit: 10 });
        // Path 2: relevant search (state_relevant) -- OR semantics, for vague
        // natural-language messages. This is the path an agent reaches for
        // when a keyword query is too strict, so the eval must exercise both.
        const relevant = await runRelevantSearch(store, task.query, { limit: 10 });

        const keywordRank = keywordResults.findIndex((n) => n.title === task.expected) + 1;
        const relevantRank = relevant.results.findIndex((n: NoteRecord) => n.title === task.expected) + 1;
        if (keywordRank === 1) keywordHitsAt1++;

        // Best rank across both paths = "can the system recall this memory?"
        const ranks = [keywordRank, relevantRank].filter((r) => r > 0);
        const rank = ranks.length ? Math.min(...ranks) : 0;

        if (rank === 1) hitsAt1++;
        if (rank >= 1 && rank <= 5) hitsAt5++;
        if (rank > 0) reciprocalRankSum += 1 / rank;
        if (rank === 0 || rank > 5) {
          misses.push(
            `"${task.query}" -> expected "${task.expected}" but got ` +
              (keywordResults.length ? `"${keywordResults[0].title}"` : "(no keyword results)") +
              ` / relevant: ${relevant.results.length ? `"${relevant.results[0].title}"` : "(none)"}`
          );
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const n = evalSet.tasks.length;
    const recallAt1 = hitsAt1 / n;
    const recallAt5 = hitsAt5 / n;
    const mrr = reciprocalRankSum / n;
    const keywordRecallAt1 = keywordHitsAt1 / n;

    // Report the metrics on every run so a regression is visible in CI logs,
    // not just as a pass/fail. The keyword-only line keeps the AND-search
    // limitation honest: it is strictly lower than best-of-both.
    console.log(
      `\n[eval] cross-device retrieval over ${n} tasks (best of keyword+relevant): ` +
        `recall@1=${recallAt1.toFixed(3)} recall@5=${recallAt5.toFixed(3)} mrr=${mrr.toFixed(3)}`
    );
    console.log(`[eval] keyword-only (state_search, AND) recall@1=${keywordRecallAt1.toFixed(3)}`);
    if (misses.length) console.log(`[eval] misses:\n  ${misses.join("\n  ")}`);

    assert.ok(
      recallAt1 >= MIN_RECALL_AT_1,
      `recall@1 ${recallAt1.toFixed(3)} fell below ${MIN_RECALL_AT_1} -- retrieval regressed`
    );
    assert.ok(
      recallAt5 >= MIN_RECALL_AT_5,
      `recall@5 ${recallAt5.toFixed(3)} fell below ${MIN_RECALL_AT_5} -- an expected note became unfindable`
    );
    assert.ok(mrr >= MIN_MRR, `MRR ${mrr.toFixed(3)} fell below ${MIN_MRR} -- ranking quality regressed`);
  });

  test("archived notes drop out of retrieval (retention x eval interaction)", async () => {
    // Simulate the retention path on an eval note: archive the expected
    // target and confirm it no longer ranks, proving "forget" actually
    // removes a memory from recall rather than just flagging it.
    const task = evalSet.tasks[0];
    const { store, dir } = seedStore(evalSet);
    try {
      const target = store.list({}).notes.find((n) => n.title === task.expected);
      assert.ok(target, "expected note is seeded");
      store.archive(target!.id);
      const results = await runSearch(store, task.query, { limit: 10 });
      assert.equal(
        results.some((n) => n.id === target!.id),
        false,
        "an archived note must not be recalled"
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
