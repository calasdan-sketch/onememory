# Per-token namespace permissions

One shared OneMemory server, several agents, each confined to its own
namespace — by **token**, not by running a separate process per agent.

This is the feature that makes a shared bridge safe. Without it, every
token that reaches one server process reads and writes the **same**
namespace: scoped tokens gated *actions* (read/write/admin) but never
*which namespace*, which is exactly how "shared memory every agent can read"
leaks secrets between projects.

---

## The problem it solves

Before per-token namespaces, isolation was **per-process**: the namespace was
resolved once at startup from the server's working directory and was a
constant for the whole process. To give two agents separate namespaces you
had to run two server processes (different cwds, or `ONEMEMORY_SPACE`).

That is real isolation, but it does not survive the common case: a Docker
one-liner plus a tunnel, three agents, three tokens, one bridge. All three
tokens saw one namespace.

## Configuration

Add an optional `namespace` to any secondary token in `tokens.json` (or
`ONEMEMORY_TOKENS`):

```json
[
  { "token": "…", "scope": "write", "label": "claude-desktop", "namespace": "personal" },
  { "token": "…", "scope": "write", "label": "cursor-work",    "namespace": "work" },
  { "token": "…", "scope": "admin", "label": "operator" }
]
```

| Token | Namespace | Sees |
|---|---|---|
| `claude-desktop` | `personal` | only `personal` |
| `cursor-work` | `work` | only `work` |
| `operator` (no pin) | server-resolved | everything (operator escape hatch) |

Each pinned token behaves as though it were its **own server**: writes land
in its namespace, reads are limited to it, and a client-supplied `namespace`
parameter is an untrusted hint that is overridden.

## Precedence

For each request:

1. **The token's `namespace` pin** — wins, always. A pinned token is confined
   to its namespace regardless of the server's cwd-resolved one.
2. **The server's startup-resolved namespace** — applies to tokens with no
   pin (byte-identical legacy behavior).
3. **Disabled** — no pin, no server namespace: the legacy permissive mode.

The **primary token** (`~/.onememory/.token` / `ONEMEMORY_TOKEN`) never
carries a pin. It is always the operator's unrestricted admin — your escape
hatch to see and repair everything. Only explicitly-namespaced secondary
tokens get confined.

## Grants are operator-controlled, never token-supplied

`reads_from` grants stay in the server's config (`spaces.json` /
`ONEMEMORY_SPACES`), keyed by namespace. A token says **where it lives**;
only the operator can say **what it may additionally read**. A token pinned
to `work` inherits `reads_from["work"]` — a token can never grant itself
access to another namespace, because the grant map is never read from the
token.

```json
{
  "spaces": { "/home/me/work": "work", "/home/me/personal": "personal" },
  "default_namespace": "personal",
  "reads_from": { "work": ["shared"] }
}
```

Here the `work`-pinned token reads `work` **and** `shared`, but not
`personal`. `shared` cannot read `work` (grants are one-directional), and no
token pinned to `shared` can write to `work` (grants never confer write).

## Isolation guarantees

Verified in `test/token-namespace.test.ts` (in the source repository):

- A pinned token **writes only to its namespace**, even if the body carries a
  different `namespace` field.
- A pinned token **cannot read, update, or delete** another namespace's note.
- Cross-namespace misses are **404, not 403** — a 403 would let an attacker
  probe which note IDs exist in other namespaces.
- A pinned token's **list, search, and vector search** are scoped to its
  namespace.
- A pinned **admin** token is still confined by the namespace gate: the pin
  constrains even privileged tokens.
- **Concurrent requests cannot cross namespaces.** The namespace context is
  resolved per request and never shared, so interleaved requests from
  different tokens cannot clobber each other's boundary mid-await.

## Threat model

**Protects against:** one agent's token reading or writing another agent's
notes on a shared bridge; a compromised or over-eager agent trying to reach
outside its namespace; a prompt-injected agent being told to "read the
`work` namespace" (the parameter is untrusted and overridden).

**Does not protect against:** an attacker who already holds the *primary*
token (that is full access by design); a malicious operator editing
`tokens.json` (they own the box); traffic analysis on an unencrypted tunnel
(put TLS in front — see [INFRA.md](../INFRA.md)); or a compromised server
process (it holds the database and every key).

**Not a substitute for encryption at rest.** Namespace permissions control
*who can ask*; encryption controls *what is readable if the file is
exfiltrated*. They are independent — see
[encryption-retention.md](./encryption-retention.md).
