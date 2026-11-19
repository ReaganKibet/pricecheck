// Chooses the best catalogue product for one parsed list item from the
// fuzzy-search candidates. Pure function so it can be tested without a DB.
import { type ParsedItem, sameSize } from "./parse.ts";

export interface Candidate {
  id: number;
  name: string;
  brand: string | null;
  category: string;
  size_value: number;
  size_unit: string;
  score: number; // 0..1 from search_products
}

export interface MatchResult {
  input: string;
  quantity: number;
  best: (Candidate & { label: string }) | null;
  alternatives: (Candidate & { label: string })[];
  any_brand_suggested: boolean; // shopper named a type ("sukari"), not a brand
  assumed_size: boolean;        // shopper gave no size; we picked one
  needs_clarification: boolean;
  question?: string;            // what the agent should ask, if anything
}

const MIN_SCORE = 0.35;

export function label(c: Candidate): string {
  const size = c.size_unit === "pcs" ? `${Number(c.size_value)} pcs` : `${Number(c.size_value)}${c.size_unit}`;
  const brand = c.brand && !c.name.startsWith(c.brand) ? `${c.brand} ` : "";
  return `${brand}${c.name} ${size}`;
}

/** Label straight from a database row (numeric columns may arrive as strings). */
export function labelFromRow(p: Record<string, unknown>): string {
  return label({
    id: Number(p.id),
    name: String(p.name),
    brand: p.brand ? String(p.brand) : null,
    category: String(p.category),
    size_value: Number(p.size_value),
    size_unit: String(p.size_unit),
    score: 0,
  });
}

export function chooseMatch(parsed: ParsedItem, candidates: Candidate[]): MatchResult {
  const base: MatchResult = {
    input: parsed.raw,
    quantity: parsed.quantity,
    best: null,
    alternatives: [],
    any_brand_suggested: false,
    assumed_size: false,
    needs_clarification: true,
  };

  const usable = candidates.filter((c) => c.score >= MIN_SCORE);
  if (usable.length === 0) {
    return { ...base, question: `I couldn't find "${parsed.raw}". What brand or type is it?` };
  }

  // Prefer the size the shopper asked for
  let pool = usable;
  if (parsed.size) {
    const sized = usable.filter((c) =>
      sameSize({ value: c.size_value, unit: c.size_unit }, parsed.size!)
    );
    if (sized.length === 0) {
      const sizes = [...new Set(usable.map((c) => label(c)))].slice(0, 3).join(", ");
      return {
        ...base,
        alternatives: usable.slice(0, 3).map((c) => ({ ...c, label: label(c) })),
        question: `I don't have "${parsed.raw}" in that size yet. Would one of these do: ${sizes}?`,
      };
    }
    pool = sized;
  }

  const top = pool[0];
  const query = parsed.query.toLowerCase();
  const namedBrand = top.brand ? query.includes(top.brand.toLowerCase()) : false;

  // Two different kinds of product scoring the same (e.g. "unga": maize or wheat flour)
  const rivalCategory = pool.find((c) => c.category !== top.category && top.score - c.score < 0.05);
  if (!namedBrand && rivalCategory) {
    return {
      ...base,
      alternatives: pool.slice(0, 4).map((c) => ({ ...c, label: label(c) })),
      question: `For "${parsed.raw}", do you mean ${top.category} or ${rivalCategory.category}?`,
    };
  }

  return {
    ...base,
    best: { ...top, label: label(top) },
    alternatives: pool.slice(1, 4).map((c) => ({ ...c, label: label(c) })),
    any_brand_suggested: !namedBrand,
    assumed_size: !parsed.size && pool.some((c) => c.category === top.category &&
      !sameSize({ value: c.size_value, unit: c.size_unit }, { value: top.size_value, unit: top.size_unit })),
    needs_clarification: false,
  };
}
