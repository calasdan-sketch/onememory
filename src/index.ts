// Entry point: boots the HTTP/JSON API on ONEMEMORY_PORT (default 8790).
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import { Store } from "./store.js";
import { createApiServer } from "./api.js";
import { exitOnListenError } from "./http-common.js";
import { DB_PATH, API_PORT, BIND_HOST, resolveTokens, assertSafeExposure, prepareDataDir } from "./config.js";
import { resolveStartupNamespace } from "./namespace.js";

prepareDataDir();
assertSafeExposure();
const tokens = resolveTokens();
const store = new Store(DB_PATH);
// Namespace resolution happens ONCE here, at startup, from the process cwd.
const nsOpts = resolveStartupNamespace(process.cwd());
if (nsOpts) {
  // eslint-disable-next-line no-console
  console.error(`[onememory] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`);
}
const server = createApiServer(store, tokens, nsOpts ?? undefined);

exitOnListenError(server, API_PORT, "ONEMEMORY_PORT", "API").listen(API_PORT, BIND_HOST, () => {
  // eslint-disable-next-line no-console
  console.error(`[onememory] API listening on http://${BIND_HOST}:${API_PORT}`);
  // eslint-disable-next-line no-console
  console.error(`[onememory] DB: ${DB_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
