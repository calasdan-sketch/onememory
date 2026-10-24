// Side-effect module, imported FIRST by every entry point: hides Node's
// one-line "ExperimentalWarning: SQLite is an experimental feature" notice
// (node:sqlite is stable enough for us; the line just alarms users and
// pollutes stdio logs). Only that exact warning is dropped -- every other
// warning still reaches Node's normal handler(s). Filtering at the
// listener (not process.emitWarning) works even though node:sqlite is
// loaded while ES modules are linked, before any module body runs:
// warnings are dispatched on a later tick.
const prior = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w: Error) => {
  if (w?.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  for (const l of prior) l.call(process, w);
});
export {};
