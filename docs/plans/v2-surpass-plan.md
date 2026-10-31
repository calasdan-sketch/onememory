# OneMemory v2 plan: match and surpass claude-mem

Owner goal: every claude-mem feature, better and easier, while staying free, private, safe, lean, and multi-agent.

Design principle: captured observations and session summaries are ordinary `notes` rows with a `kind` column, so they inherit lint, quarantine, version history, FTS, vectors, sync, trust and the dashboard. Raw tool events live in a short-lived `capture_events` side table and are never synced.

Phase 1: schema v16 (notes.kind/session_id/obs_type, sessions, capture_events, note_files, file_context_seen); src/hook.ts (`onememory hook <event>`, stdin JSON, fail-open, always exit 0, JSONL spool, never migrates); src/capture.ts; src/redact.ts (<private> strip + secret redaction reusing security.ts patterns); src/extract.ts (free deterministic observations: files, git commits typed by conventional prefix, test runs, fail->pass bugfix, security notes, decisions; one summary per session); src/context-inject.ts (relevance-ranked SessionStart injection: RRF of bm25 over branch/diff/recent files/last summary + file overlap + recency, token budget ONEMEMORY_RECALL_TOKENS=1500, savings footer, untrusted banner); MCP tools memory_index / memory_timeline / memory_get / session_list; REST /index /timeline /get /sessions /sessions/:id /files/timeline /capture; setup planHooks with consent (--capture/--no-capture), diff/backup/undo; reserved obs tags; skills/onememory-mem/SKILL.md.

Phase 1 status: done (commits up to 19b9a1c).

Phase 2: PreToolUse(Read) file-context (advisory, never denies), dashboard Sessions/timeline tab, optional local LLM summarizer (one batched call per session, re-linted, falls back), ONEMEMORY_EMBEDDINGS=auto.

Phase 2 status: done.
- file-context: src/file-context.ts, `onememory hook file-context`, setup adds `PreToolUse` matcher `Read` (synchronous) with --capture. Never emits a permissionDecision; file_context_seen claimed only when there is something to say; old claims swept with the capture events.
- Dashboard Sessions tab (src/dashboard.ts) over GET /sessions and GET /sessions/:id; the latter (and session_list over MCP) now also returns the session's redacted prompts while its raw events are kept.
- src/llm.ts: OpenAI-compatible chat call at session-end only; loopback only unless ONEMEMORY_LLM_ALLOW_REMOTE=1; redirects refused; written via Store.update (lint/quarantine); facts lines (files, commands, errors, outcome) kept under the model's text.
- ONEMEMORY_EMBEDDINGS=auto in src/embeddings.ts: silent, 60 s back-off after a failure, 5 s default timeout.
- Phase 1 known gaps closed: export/import and vault sync carry kind/session_id/obs_type/files (and recreate the session row); accessStats/staleCount/consolidation ignore captured rows; encrypt enable/disable reseal capture_events outputs.
- Closed: capture_events.input is now sealed into input_enc like the output (own AAD, so the two envelopes cannot be swapped; `encrypt enable/disable` reseal both; first-v16 databases get the column on open). An LLM-rewritten summary carries the reserved tag `obs.writer:model`, shown as "(model-written)" by memory_get / memory_index (`model_written: true`) and the SessionStart injection; a re-distill drops it.
- Still open: titles of capture-written notes (like every note title) stay plaintext with encryption on, so a prompt quoted in a summary title is readable at rest; the JSONL spool holds redacted events in plaintext until drained.

Phase 3: transcript watcher for hookless hosts, Cursor/Codex/Gemini installers, bench/vs-claude-mem.

Never build: Chroma, worker daemon, corpora, per-tool-call LLM, telemetry.
