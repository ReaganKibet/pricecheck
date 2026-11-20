// Demo engine: the same parse / match / compare code the edge functions use,
// with the database swapped for the bundled sample data.
import { parseItem } from "../../supabase/functions/_shared/parse.ts";
import { type Candidate, chooseMatch, type MatchResult } from "../../supabase/functions/_shared/match.ts";
import {
  type BasketItem,
  compareBasket,
  type CompareResult,
  type PriceRow,
  type ProductInfo,
  type Retailer,
} from "../../supabase/functions/_shared/compare.ts";
import { SIMILARITY_THRESHOLD, similarity, WORD_SIMILARITY_THRESHOLD, wordSimilarity } from "./trigram.ts";
import data from "./sample-data.json";

type Product = ProductInfo & { search_text: string };

const products = data.products as Product[];
const retailers = data.retailers as Retailer[];

// Sample prices are dated "yesterday" whenever the page is opened, and the
// promo runs for five more days, so the demo never shows stale-price notes.
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const prices: PriceRow[] = (data.prices as Omit<PriceRow, "observed_at">[]).map((p) => ({
  ...p,
  observed_at: yesterday,
}));

/** Same rules as the SQL function search_products(). */
export function searchProducts(q: string, max = 8): Candidate[] {
  const query = q.toLowerCase();
  return products
    .map((p) => {
      const s = similarity(p.search_text, query);
      const w = wordSimilarity(query, p.search_text);
      return { p, s, w, score: Math.max(s, w) };
    })
    .filter((x) => x.s >= SIMILARITY_THRESHOLD || x.w >= WORD_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.p.id - b.p.id)
    .slice(0, max)
    .map(({ p, score }) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      size_value: p.size_value,
      size_unit: p.size_unit,
      score,
    }));
}

/** Same as POST /match-items. */
export function matchItems(lines: string[]): MatchResult[] {
  return lines.map((line) => {
    const parsed = parseItem(line);
    return chooseMatch(parsed, searchProducts(parsed.query || line));
  });
}

/** Same as POST /compare-basket. */
export function compare(items: BasketItem[]): CompareResult {
  return compareBasket(items, products, prices, retailers, { splitThresholdKes: 200 });
}

/** Split a pasted list into lines: new lines, commas or semicolons. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function productLabel(id: number): string {
  const p = products.find((x) => x.id === id);
  if (!p) return `product ${id}`;
  const size = p.size_unit === "pcs" ? ` (${p.size_value} pcs)` : ` ${p.size_value}${p.size_unit}`;
  const brand = p.brand && !p.name.startsWith(p.brand) ? `${p.brand} ` : "";
  return `${brand}${p.name}${size}`;
}

export const catalogue = products.map((p) => ({ id: p.id, label: productLabel(p.id), category: p.category }));
export const retailerNames = retailers.map((r) => r.name);
