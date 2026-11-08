const STOPWORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "do",
  "does",
  "find",
  "for",
  "from",
  "get",
  "give",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "most",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "s",
  "see",
  "show",
  "should",
  "tell",
  "that",
  "the",
  "there",
  "this",
  "to",
  "top",
  "us",
  "want",
  "what",
  "which",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

// Tokenizer-friendly synonym targets; multi-word values are split by the
// FTS5 query builder.
export const SYNONYMS: Record<string, string> = {
  slow: "latency",
  disk: "block io",
  io: "block",
  network: "tcp",
};

export function extractKeywords(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token === "" || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw === "" || STOPWORDS.has(raw)) continue;
    push(raw);
    const mapped = SYNONYMS[raw];
    if (mapped !== undefined) {
      for (const extra of mapped.split(" ")) {
        if (!STOPWORDS.has(extra)) push(extra);
      }
    }
  }
  return out;
}

export function buildFtsQuery(keywords: string[]): string {
  const terms: string[] = [];
  for (const keyword of keywords) {
    // Split multi-word synonym expansions into individual quoted terms.
    for (const part of keyword.split(/\s+/)) {
      const token = part.replace(/["*]/g, "").trim();
      if (token !== "") terms.push(`"${token}"`);
    }
  }
  return terms.join(" OR ");
}
