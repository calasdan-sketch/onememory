// Entry point for the command runner: `npm run runner`.
// Kept separate from runner.ts so the module can be imported by tests and by
// other surfaces without starting a polling loop as a side effect.
import { main } from "./runner.js";

main();
