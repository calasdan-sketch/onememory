// Deterministic keyword extraction for the `state_relevant` tool (and
// `POST /relevant`): turns a vague natural-language message into a small set
// of search keywords. Zero dependencies, no ML, no external calls --
// lowercase, punctuation split, stop-word removal, short-token drop,
// dedup, top-20 cap. Hashtags (e.g. #status, #goal) are preserved as-is
// (unstemmed, kept even when short) because they are deliberate tags, not
// prose.
//
// ENGLISH-ONLY LIMITATION (documented, not fixed): the stop-word list is
// English. French/German function words ("le", "der", "und") survive as
// keywords, and CJK text is not segmented (it has no whitespace) -- CJK
// queries degrade to whole-phrase tokens. This is a documented precision
// tradeoff of the zero-dependency design, not a crash: non-English input
// still searches, just with noisier keywords.

// ~160 common English stop-words, plus the bare stems left behind when
// contractions lose their apostrophes ("don't" -> "don" "t"), plus
// conversational filler ("hey", "hi", "thanks", "hello") that would
// otherwise become keywords in greeting-heavy messages ("hey, can you...").
//
// English-only by design (see module header): non-English function words
// are NOT filtered.
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "almost", "also",
  "always", "am", "among", "an", "and", "another", "any", "anybody", "anyone",
  "anything", "anywhere", "are", "aren", "around", "as", "at", "be", "became",
  "because", "become", "becomes", "becoming", "been", "before", "behind",
  "being", "below", "between", "both", "but", "by", "can", "cannot", "cant",
  "could", "couldn", "did", "didn", "do", "does", "doesn", "doing", "don",
  "done", "down", "during", "each", "either", "else", "elsewhere", "enough",
  "even", "ever", "every", "everybody", "everyone", "everything", "everywhere",
  "few", "fewer", "for", "from", "further", "get", "gets", "getting", "got",
  "had", "hadn", "has", "hasn", "have", "haven", "having", "he", "hello",
  "her", "here", "hers", "herself", "hey", "hi", "him", "himself", "his", "how", "however", "i",
  "if", "in", "into", "is", "isn", "it", "its", "itself", "just", "keep",
  "kept", "like", "made", "many", "may", "me", "might", "more", "most",
  "mostly", "much", "must", "my", "myself", "never", "no", "nobody", "none",
  "nor", "not", "nothing", "now", "nowhere", "of", "off", "often", "on",
  "once", "one", "only", "onto", "or", "other", "others", "ought", "our",
  "ours", "ourselves", "out", "over", "own", "quite", "rather", "really",
  "said", "same", "seem", "seemed", "seeming", "seems", "several", "shall",
  "she", "should", "shouldn", "since", "so", "some", "somebody", "someone",
  "something", "somewhere", "still", "such", "take", "than", "thank", "thanks",
  "that", "the",
  "their", "theirs", "them", "themselves", "then", "thence", "there",
  "thereafter", "thereby", "therefore", "therein", "thereupon", "these",
  "they", "this", "those", "though", "through", "throughout", "thru", "thus",
  "to", "together", "too", "toward", "towards", "under", "until", "up",
  "upon", "us", "use", "used", "uses", "very", "via", "was", "wasn", "we",
  "well", "were", "weren", "what", "whatever", "when", "whence", "whenever",
  "where", "whereby", "wherein", "whereupon", "wherever", "whether", "which",
  "while", "whither", "who", "whoever", "whom", "whose", "why", "will",
  "with", "within", "without", "won", "would", "wouldn", "yes", "yet", "you",
  "your", "yours", "yourself", "yourselves",
]);

/** Max keywords returned -- keeps the downstream FTS fan-out bounded. */
export const MAX_KEYWORDS = 20;

function pushKeyword(seen: Set<string>, out: string[], tok: string): void {
  if (seen.has(tok)) return;
  seen.add(tok);
  out.push(tok);
}

/**
 * Extract search keywords from free-form text. Deterministic: same input,
 * same output. Tokens are first-occurrence ordered, deduplicated, capped at
 * MAX_KEYWORDS. Hashtags are kept unstemmed and are exempt from the
 * short-token drop and stop-word removal.
 *
 * Dedupe is on the BARE STEM, not the surface form: a hashtag and its prose
 * twin ("#status" + "status") yield ONE keyword (first occurrence wins).
 * Without this, FTS5's unicode61 tokenizer strips "#" at index AND query
 * time, so both branches match the same notes and the merge double-counts
 * (count=2), outranking genuinely distinct keywords.
 *
 * Tokenizer contract (deliberately different from the edge-graph tokenizer
 * in consolidate.ts, which keeps >= 2 chars for cosine scoring): query
 * keywords drop < 3-char tokens for precision, EXCEPT tokens containing a
 * digit ("S3", "EC2", "Q3") -- short alphanumeric codes are high-signal and
 * would otherwise vanish from relevant search while living on in FTS/edges.
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  // Bare stems already emitted, in either surface form ("status" covers
  // "#status" and vice versa): first occurrence wins, no double-count.
  const bareSeen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith("#") && raw.length > 1) {
      // Hashtag: keep as-is (unstemmed), punctuation stripped from the body.
      // Kept even when short and even if it looks like a stop-word -- a
      // hashtag is a deliberate tag, not prose.
      const bare = raw.slice(1).replace(/[^\p{L}\p{N}]/gu, "");
      if (bare.length === 0) continue; // bare "#" or "#!!!"
      if (bareSeen.has(bare)) continue; // prose twin already emitted
      bareSeen.add(bare);
      pushKeyword(seen, out, "#" + bare);
    } else {
      // Prose token: punctuation becomes a separator, so "don't" -> "don"
      // "t" and "well-known" -> "well" "known".
      for (const part of raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        // Digit carve-out: "s3"/"ec2" survive the short-token drop.
        if (part.length < 3 && !/\d/.test(part)) continue;
        if (STOP_WORDS.has(part)) continue;
        if (bareSeen.has(part)) continue; // hashtag twin already emitted
        bareSeen.add(part);
        pushKeyword(seen, out, part);
      }
    }
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}
