/** Query tokenization and FTS5 MATCH construction. Sanitized tokens only — injection-safe by construction. */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "my",
  "this",
  "that",
  "icon",
  "symbol",
  "glyph",
  "button",
  "show",
  "display",
  "represent",
  "representing",
  "user",
  "app",
]);

/** Lowercased [a-z0-9_] tokens, stopwords removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export interface LexicalQuery {
  /** FTS5 MATCH expression, or null when no usable tokens remain. */
  match: string | null;
  tokens: string[];
}

/**
 * Build an OR-query over sanitized tokens. Tokens of length >= 4 also match
 * as prefixes ("magnify" -> magnifyingglass). A `direction` adds the
 * directional bigrams indexed in name_tokens.
 */
export function buildMatch(
  texts: string[],
  direction?: string,
): LexicalQuery {
  const tokens = [...new Set(texts.flatMap(tokenize))];
  const terms: string[] = [];
  for (const token of tokens) {
    terms.push(`"${token}"`);
    if (token.length >= 4) terms.push(`${token}*`);
  }
  if (direction) {
    terms.push(`"arrow_${direction}"`, `"chevron_${direction}"`, `"${direction}"`);
  }
  return {
    match: terms.length > 0 ? terms.join(" OR ") : null,
    tokens,
  };
}

/** Candidate exact-name forms of a free-text query ("arrow down" -> "arrow.down"). */
export function exactNameCandidates(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  const dotted = trimmed.replace(/\s+/g, ".");
  return [...new Set([trimmed, dotted])].filter((s) =>
    /^[a-z0-9][a-z0-9.]*$/.test(s),
  );
}
