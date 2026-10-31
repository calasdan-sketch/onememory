// Optional semantic-search embeddings.
//
// OFF by default -- keyword (FTS5) search is the zero-dependency default and
// nothing here runs unless ONEMEMORY_EMBEDDINGS is turned on. When on,
// embeddings are produced by *your own* OpenAI-compatible endpoint (Ollama's
// `/v1/embeddings`, a local text-embedding server, or any OpenAI-shaped API).
// Nothing is sent to a third party you didn't configure, and there are still
// zero native modules -- this is a plain fetch().
//
// Every failure path returns null so the caller silently falls back to
// keyword search. A memory tool must never lose a write or a query because
// an optional embedding server was down.
//
// ONEMEMORY_EMBEDDINGS=auto: use embeddings when the configured endpoint
// answers, keyword-only when it does not, without a word on stderr. A failed
// call marks the endpoint down for AUTO_RETRY_MS (no request at all until
// then), and the timeout is AUTO_TIMEOUT_MS unless ONEMEMORY_EMBED_TIMEOUT_MS
// is set, so a machine without the backend never waits on it.

const AUTO_RETRY_MS = 60_000;
const AUTO_TIMEOUT_MS = 5000;
/** auto mode: no call before this time (the endpoint failed recently). */
let autoDownUntil = 0;

export interface EmbeddingsConfig {
  enabled: boolean;
  /** ONEMEMORY_EMBEDDINGS=auto: a failure is silent and backs off. */
  auto?: boolean;
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export function embeddingsConfig(): EmbeddingsConfig {
  const flag = (process.env.ONEMEMORY_EMBEDDINGS || "").trim().toLowerCase();
  const auto = flag === "auto";
  const enabled = auto || flag === "1" || flag === "on" || flag === "true" || flag === "yes";
  return {
    enabled,
    ...(auto ? { auto: true } : {}),
    // Ollama's OpenAI-compatible route by default; override for any other.
    url: process.env.ONEMEMORY_EMBED_URL || "http://localhost:11434/v1/embeddings",
    model: process.env.ONEMEMORY_EMBED_MODEL || "nomic-embed-text",
    apiKey: process.env.ONEMEMORY_EMBED_KEY || undefined,
    // 30s default: a local embedding model's first (cold-load) call can be
    // slow; after that it's fast. Raise it with ONEMEMORY_EMBED_TIMEOUT_MS.
    timeoutMs: Number(process.env.ONEMEMORY_EMBED_TIMEOUT_MS || (auto ? AUTO_TIMEOUT_MS : 30000)),
  };
}

/** Test hook: forget an auto-mode "endpoint is down" mark. */
export function resetEmbeddingsAuto(): void {
  autoDownUntil = 0;
}

export function embeddingsEnabled(): boolean {
  return embeddingsConfig().enabled;
}

/** Text used to represent a note for embedding. */
export function noteEmbeddingText(title: string, body: string): string {
  return body && body.trim() ? `${title}\n\n${body}` : title;
}

function parseEmbedding(json: unknown): Float32Array | null {
  // OpenAI shape: { data: [ { embedding: number[] } ] }
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data) && data[0] && Array.isArray((data[0] as { embedding?: unknown }).embedding)) {
    return Float32Array.from((data[0] as { embedding: number[] }).embedding);
  }
  // Ollama native shape: { embedding: number[] }  (fallback)
  const emb = (json as { embedding?: unknown }).embedding;
  if (Array.isArray(emb)) return Float32Array.from(emb as number[]);
  return null;
}

/**
 * Embed a single string. Returns null (never throws) on disabled, timeout,
 * network error, non-200, or an unrecognized response shape.
 */
export async function embed(
  text: string,
  cfg: EmbeddingsConfig = embeddingsConfig()
): Promise<Float32Array | null> {
  if (!cfg.enabled || !text || !text.trim()) return null;
  if (cfg.auto && Date.now() < autoDownUntil) return null;
  // auto: a failure is expected (no backend on this machine), so it is quiet and backs off instead of logging.
  const fail = (msg: string): null => {
    if (cfg.auto) autoDownUntil = Date.now() + AUTO_RETRY_MS;
    else console.error(msg);
    return null;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) return fail(`[onememory] embeddings endpoint returned ${res.status}; using keyword search`);
    const json = (await res.json()) as unknown;
    const vec = parseEmbedding(json);
    if (!vec || vec.length === 0) return fail("[onememory] embeddings response had no vector; using keyword search");
    if (cfg.auto) autoDownUntil = 0;
    return vec;
  } catch (e) {
    return fail(`[onememory] embeddings call failed (${(e as Error).message}); using keyword search`);
  } finally {
    clearTimeout(timer);
  }
}
