// Entry point for the command runner: `npm run runner`.
// Kept separate from runner.ts so the module can be imported by tests and by
// other surfaces without starting a polling loop as a side effect.
import { setProcessWriter } from "./actor.js";
import { main } from "./runner.js";

// Everything this process writes (its heartbeat, task outcomes) is stamped
// written_by = "runner". A token can never carry that exact name (it would be
// stored as `token:runner`), which is how runner_status tells a real heartbeat
// from a forged one.
setProcessWriter("runner");
main();
