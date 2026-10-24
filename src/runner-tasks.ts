// Command tasks: connect the task board to the signed command runner.
//
//   phone / any session:  task_put({ command: {action, params}, target })
//        -> a task in status `queued` (needs only a WRITE token; it cannot run)
//   admin (a person):     task_approve({ id })      (ADMIN scope)
//        -> the store stamps an approval bound to hash(namespace, id, command, target)
//   this PC's runner:     pollTasks() every poll
//        -> runs it through the SAME gates as a command note, then writes the
//           outcome back to the task (done / failed + result) and a signed
//           result note.
//
// What gates execution (all must hold; each is independent):
//   1. NAMESPACE   the task lives in exactly RUNNER.taskNamespace (opt-in env
//                  ONEMEMORY_RUNNER_TASK_NAMESPACE; unset = this feature is off).
//                  Namespace resolution in an API process can only move a task
//                  OUT of that namespace, where this runner never looks.
//   2. TARGET      command.target equals THIS runner's own id (runnerId()).
//                  Another machine's tasks are left untouched.
//   3. APPROVAL    a valid, unexpired store-keyed MAC over (namespace, task id,
//                  nonce, expiry, hash of the command and target), written only by the
//                  admin-scope approve path. Editing the command, params or
//                  target (or re-queuing) voids it; a tag copied onto another
//                  task or forged by a note writer fails the MAC (the tag
//                  family is reserved, and the key never leaves the store).
//   4. REPLAY      the approval is single-use: it is REMOVED from the task in
//                  the same compare-and-swap write that marks it running (so a
//                  crash or a lost ledger cannot replay it), and cmd_id
//                  `task-<id>-<nonce>` also goes into the local ledger BEFORE running.
//   5. ALLOWLIST   the action must be on THIS PC's allowlist with params
//                  matching its patterns (resolveAction): exactly the gate
//                  command notes pass. No allowlist, no run.
//
// The runner signs the in-memory envelope with ITS OWN secret and runs it
// through verifyCommand (so the same canonical-form and control-character
// checks apply). The secret never touches the store, the API or a token:
// the phone / low-privilege token can queue a task and nothing more.
//
// "Read-only vs mutating": the runner has no per-action read-only flag, and
// this feature does not invent one. EVERY command task needs an explicit
// admin approval, whatever the action does.
import { randomUUID } from "node:crypto";
import {
  RUNNER,
  runnerId,
  signCommand,
  verifyCommand,
  executeCommand,
  hasControlChars,
  COMMAND_FORMAT,
  type RunnerDeps,
  type CommandEnvelope,
} from "./runner.js";
import { queuedCommandTasks, markCommandRunning, finishCommandTask, classifyQueuedCommand, approvalNonce } from "./tasks.js";
import { audit } from "./security.js";

/** One pass over the queued command tasks. Returns how many were run or failed. */
export async function pollTasks(deps: RunnerDeps): Promise<number> {
  const ns = deps.taskNamespace ?? RUNNER.taskNamespace;
  if (!ns) return 0;
  const me = deps.runnerId ?? runnerId();
  const now = (deps.now ?? Date.now)();

  deps.recent = (deps.recent ?? []).filter((t) => now - t < RUNNER.windowMs);
  let room = Math.min(RUNNER.maxPerPoll, Math.max(0, RUNNER.maxPerWindow - deps.recent.length));
  let handled = 0;

  // Oldest first, in the order they were queued.
  const queued = queuedCommandTasks(deps.store, ns).reverse();
  for (const note of queued) {
    if (room <= 0) break;
    // The ONE rule shared with the runner-status view (tasks.ts): right
    // namespace, addressed to this runner (another machine's task is left
    // alone), approval MAC valid and unexpired (edited since approval, or
    // forged: never runs), no live lease. A command task cannot be claimed
    // (claimTask refuses) and approve/revoke clear any lease, so a live lease
    // on an APPROVED task can only predate the approval; the runner never
    // preempts another owner, and re-approving clears it.
    const verdict = classifyQueuedCommand(deps.store, note, { me, namespace: ns }, now);
    if (verdict.kind !== "runnable") continue;
    const cmd = verdict.command;

    const nonce = approvalNonce(note);
    const cmdId = `task-${note.id}-${nonce}`;
    // CAS queued -> running on the exact revision we verified: if anyone
    // edited the task since, this fails and nothing runs this pass.
    const running = markCommandRunning(deps.store, note);
    if (!running) continue;
    room--;
    deps.recent.push(now);
    handled++;
    audit({ op: "runner.task", id: note.id, namespace: note.namespace, kind: "command-task" });

    const base = {
      cmd_id: cmdId,
      action: cmd.action,
      params: cmd.params,
      target: cmd.target,
      issued_at: new Date(now).toISOString(),
      nonce: randomUUID(),
    };
    try {
      if (hasControlChars(base)) {
        finishCommandTask(deps.store, note.id, { ok: false, status: "refused", reason: "control characters are not allowed" });
        continue;
      }
      const env: CommandEnvelope = { v: COMMAND_FORMAT, ...base, sig: signCommand(deps.secret, base) };
      const verdict = verifyCommand(deps.secret, JSON.stringify(env), now, RUNNER.freshnessMs);
      if (!verdict.ok) {
        finishCommandTask(deps.store, note.id, { ok: false, status: "rejected", reason: verdict.reason });
        continue;
      }
      if (deps.ledger.has(cmdId)) {
        audit({ op: "runner.replay", id: note.id });
        finishCommandTask(deps.store, note.id, { ok: false, status: "rejected", reason: "this approval was already used" });
        continue;
      }
      // Record BEFORE running: a crash mid-command must not re-run it on restart.
      deps.ledger.add(cmdId);
      const done = await executeCommand(deps, verdict.cmd, note.id, note.namespace);
      finishCommandTask(deps.store, note.id, {
        ok: done.ok,
        status: done.status,
        exit_code: done.exit_code,
        output: done.output,
        reason: done.reason,
      });
    } catch (e) {
      console.error(`[onememory:runner] command task ${note.id} failed:`, e);
      try {
        finishCommandTask(deps.store, note.id, { ok: false, status: "error", reason: "runner error" });
      } catch {
        /* the task stays `running`; the signed result note / log carry the story */
      }
    }
  }
  deps.ledger.flush();
  return handled;
}
