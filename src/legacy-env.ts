// Side-effect module: OneMemory used to be called claude-bridge, and its settings were CLAUDE_BRIDGE_* variables
// (CLAUDE_BRIDGE_DB_PATH, CLAUDE_BRIDGE_TOKEN, ...). Anyone who moved to OneMemory with the old variables still set
// would otherwise start on an EMPTY database without a word. So every CLAUDE_BRIDGE_<NAME> is read as
// ONEMEMORY_<NAME>. The new name always wins when both are set. Nothing is ever written back to the environment
// of other programs: this only fills in missing ONEMEMORY_* values for this process.
//
// Imported first by every entry point and by config.ts, before anything reads process.env.

const LEGACY_PREFIX = "CLAUDE_BRIDGE_";
const NEW_PREFIX = "ONEMEMORY_";

/** Copy each CLAUDE_BRIDGE_<NAME> to the matching new name where that is unset. Returns the old names that were mapped. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const mapped: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_PREFIX) || key.length === LEGACY_PREFIX.length) continue;
    const value = env[key];
    if (value === undefined || value === "") continue;
    const next = NEW_PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[next] === undefined || env[next] === "") {
      env[next] = value;
      mapped.push(key);
    }
  }
  return mapped;
}

/** The old names that were mapped in this process (for `doctor`). */
export const MAPPED_LEGACY_ENV: readonly string[] = applyLegacyEnv();
