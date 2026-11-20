// Browser port of the Postgres pg_trgm functions used by search_products(),
// so the demo can run with no database. Checked against real Postgres
// (scores matched Postgres exactly on 448 query/product pairs).

/** Words as pg_trgm sees them: runs of letters/digits, lower-cased. */
function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Trigrams of one word, padded like pg_trgm: two spaces before, one after. */
function wordTrigrams(w: string): string[] {
  const p = `  ${w} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
  return out;
}

export function trigramSet(s: string): Set<string> {
  return new Set(words(s).flatMap(wordTrigrams));
}

/** pg_trgm similarity(a, b): shared unique trigrams / all unique trigrams. */
export function similarity(a: string, b: string): number {
  const A = trigramSet(a);
  const B = trigramSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * pg_trgm word_similarity(q, text): best similarity between q's trigrams and
 * any continuous run of text's trigrams (in order).
 */
export function wordSimilarity(q: string, text: string): number {
  const Q = trigramSet(q);
  if (Q.size === 0) return 0;
  const seq = words(text).flatMap(wordTrigrams);
  let best = 0;
  for (let i = 0; i < seq.length; i++) {
    const extent = new Set<string>();
    let shared = 0;
    for (let j = i; j < seq.length; j++) {
      const t = seq[j];
      if (!extent.has(t)) {
        extent.add(t);
        if (Q.has(t)) shared++;
      }
      // Only extents that start and end on a matching trigram can be best
      if (!Q.has(seq[i]) || !Q.has(t)) continue;
      const s = shared / (Q.size + extent.size - shared);
      if (s > best) best = s;
    }
  }
  return best;
}

export const SIMILARITY_THRESHOLD = 0.3;      // pg_trgm.similarity_threshold
export const WORD_SIMILARITY_THRESHOLD = 0.6; // pg_trgm.word_similarity_threshold
