// Who is writing? The label of the token (or MCP connection) behind the call,
// carried through async code so the store can stamp it on the change_log row
// of every write (change_log.actor). It is NOT the note's `source`
// (provenance a client can set freely): exclude_self filters on the actor.
//
// A per-request holder object (not a bare string) lets the HTTP API open the
// context before it has authenticated and fill the label in afterwards.
import { AsyncLocalStorage } from "node:async_hooks";

export interface ActorRef {
  label: string;
}

export const actorStore = new AsyncLocalStorage<ActorRef>();

/** The writer's label for the current call, or "" (CLI, scripts, unknown). */
export function currentActor(): string {
  return actorStore.getStore()?.label ?? "";
}
