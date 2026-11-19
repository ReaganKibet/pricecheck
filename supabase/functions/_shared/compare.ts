// Basket comparison: the numbers shoppers see. Deterministic code only.
// The AI agent never adds up prices; it calls this (via compare-basket)
// and reports what comes back.
//
// All money is handled in cents (integers) to avoid floating-point errors.

import { sameSize } from "./parse.ts";

export interface BasketItem {
  product_id: number;
  quantity: number;
  any_brand?: boolean; // allow the cheapest product of the same category and size
}

export interface ProductInfo {
  id: number;
  name: string;
  brand: string | null;
  category: string;
  size_value: number;
  size_unit: string;
}

export interface PriceRow {
  product_id: number;
  retailer_id: number;
  price: number;              // KES
  promo_price: number | null; // KES, only when a promotion is live
  observed_at: string;        // ISO date
  source: string;
}

export interface Retailer {
  id: number;
  code: string;
  name: string;
}

export interface CompareOptions {
  splitThresholdKes?: number; // only suggest splitting if it saves at least this much
  staleAfterDays?: number;    // flag prices older than this
  now?: Date;
}

export interface Line {
  item_index: number;
  requested_product_id: number;
  product_id: number;
  product_name: string;
  substituted: boolean;  // a different brand was picked (any-brand mode)
  quantity: number;
  unit_price_kes: number;
  line_total_kes: number;
  on_offer: boolean;
  regular_price_kes: number;
  price_date: string;
  stale: boolean;
}

export interface RetailerResult {
  retailer_code: string;
  retailer_name: string;
  total_kes: number;          // total of the items this store has
  items_found: number;
  items_missing: number;
  missing: { item_index: number; product_name: string }[];
  offers_used: number;
  has_stale_prices: boolean;
  lines: Line[];
}

export interface CompareResult {
  item_count: number;
  ranking: RetailerResult[];  // fewest missing items first, then cheapest
  best: {
    retailer_code: string;
    retailer_name: string;
    total_kes: number;
    saving_vs_most_expensive_kes: number;
    most_expensive_retailer: string;
  } | null;                   // null when no store has every item
  split: {
    total_kes: number;
    saving_vs_best_kes: number;
    worth_it: boolean;
    stores: { retailer_name: string; items: string[] }[];
  } | null;                   // null when some item is not stocked anywhere
  not_found_anywhere: { item_index: number; product_name: string }[];
  notes: string[];
}

const toCents = (kes: number) => Math.round(kes * 100);
const toKes = (cents: number) => Math.round(cents) / 100;

export function compareBasket(
  items: BasketItem[],
  products: ProductInfo[],
  prices: PriceRow[],
  retailers: Retailer[],
  opts: CompareOptions = {},
): CompareResult {
  const splitThresholdCents = toCents(opts.splitThresholdKes ?? 200);
  const staleMs = (opts.staleAfterDays ?? 7) * 86_400_000;
  const now = (opts.now ?? new Date()).getTime();

  const productById = new Map(products.map((p) => [p.id, p]));
  const priceKey = (productId: number, retailerId: number) => `${productId}:${retailerId}`;
  const priceIndex = new Map(prices.map((r) => [priceKey(r.product_id, r.retailer_id), r]));

  // Which products may stand in for each requested item
  const candidatesFor = (item: BasketItem): ProductInfo[] => {
    const wanted = productById.get(item.product_id);
    if (!wanted) return [];
    if (!item.any_brand) return [wanted];
    return products.filter(
      (p) =>
        p.category === wanted.category &&
        sameSize({ value: p.size_value, unit: p.size_unit }, { value: wanted.size_value, unit: wanted.size_unit }),
    );
  };

  const nameOf = (id: number) => {
    const p = productById.get(id);
    if (!p) return `product ${id}`;
    return `${p.brand && !p.name.startsWith(p.brand) ? p.brand + " " : ""}${p.name} ${formatSize(p)}`;
  };

  // Cheapest line for an item at one retailer, or null if not stocked
  const lineAt = (item: BasketItem, index: number, retailer: Retailer): Line | null => {
    let best: { product: ProductInfo; row: PriceRow; unitCents: number } | null = null;
    for (const product of candidatesFor(item)) {
      const row = priceIndex.get(priceKey(product.id, retailer.id));
      if (!row) continue;
      const unitCents = toCents(row.promo_price ?? row.price);
      if (!best || unitCents < best.unitCents ||
          (unitCents === best.unitCents && product.id === item.product_id)) {
        best = { product, row, unitCents };
      }
    }
    if (!best) return null;
    return {
      item_index: index,
      requested_product_id: item.product_id,
      product_id: best.product.id,
      product_name: nameOf(best.product.id),
      substituted: best.product.id !== item.product_id,
      quantity: item.quantity,
      unit_price_kes: toKes(best.unitCents),
      line_total_kes: toKes(Math.round(best.unitCents * item.quantity)),
      on_offer: best.row.promo_price != null,
      regular_price_kes: best.row.price,
      price_date: best.row.observed_at,
      stale: now - Date.parse(best.row.observed_at) > staleMs,
    };
  };

  // Per-retailer totals
  const results: (RetailerResult & { totalCents: number })[] = retailers.map((retailer) => {
    const lines: Line[] = [];
    const missing: RetailerResult["missing"] = [];
    items.forEach((item, i) => {
      const line = lineAt(item, i, retailer);
      if (line) lines.push(line);
      else missing.push({ item_index: i, product_name: nameOf(item.product_id) });
    });
    const totalCents = lines.reduce((s, l) => s + toCents(l.line_total_kes), 0);
    return {
      retailer_code: retailer.code,
      retailer_name: retailer.name,
      total_kes: toKes(totalCents),
      totalCents,
      items_found: lines.length,
      items_missing: missing.length,
      missing,
      offers_used: lines.filter((l) => l.on_offer).length,
      has_stale_prices: lines.some((l) => l.stale),
      lines,
    };
  });

  const ranked = results
    .filter((r) => r.items_found > 0)
    .sort((a, b) => a.items_missing - b.items_missing || a.totalCents - b.totalCents);

  const complete = ranked.filter((r) => r.items_missing === 0);
  const notes: string[] = [];

  let best: CompareResult["best"] = null;
  if (complete.length > 0) {
    const cheapest = complete[0];
    const priciest = complete[complete.length - 1];
    best = {
      retailer_code: cheapest.retailer_code,
      retailer_name: cheapest.retailer_name,
      total_kes: cheapest.total_kes,
      saving_vs_most_expensive_kes: toKes(priciest.totalCents - cheapest.totalCents),
      most_expensive_retailer: priciest.retailer_name,
    };
  } else if (ranked.length > 0) {
    notes.push("No single store has every item; totals only include the items each store stocks.");
  }

  // Cheapest store for each item, and whether splitting the shop pays
  const notFound: CompareResult["not_found_anywhere"] = [];
  const winners: { index: number; retailer: string; cents: number; name: string }[] = [];
  items.forEach((item, i) => {
    let win: { retailer: string; cents: number; name: string } | null = null;
    for (const r of results) {
      const line = r.lines.find((l) => l.item_index === i);
      if (!line) continue;
      const cents = toCents(line.line_total_kes);
      if (!win || cents < win.cents) win = { retailer: r.retailer_name, cents, name: line.product_name };
    }
    if (win) winners.push({ index: i, ...win });
    else notFound.push({ item_index: i, product_name: nameOf(item.product_id) });
  });

  let split: CompareResult["split"] = null;
  if (notFound.length === 0 && items.length > 0) {
    const splitCents = winners.reduce((s, w) => s + w.cents, 0);
    const savingCents = best ? toCents(best.total_kes) - splitCents : 0;
    const byStore = new Map<string, string[]>();
    for (const w of winners) byStore.set(w.retailer, [...(byStore.get(w.retailer) ?? []), w.name]);
    split = {
      total_kes: toKes(splitCents),
      saving_vs_best_kes: toKes(savingCents),
      worth_it: best !== null && byStore.size > 1 && savingCents >= splitThresholdCents,
      stores: [...byStore].map(([retailer_name, names]) => ({ retailer_name, items: names })),
    };
  }

  if (notFound.length > 0) notes.push(`${notFound.length} item(s) have no price at any store yet.`);
  if (ranked.some((r) => r.has_stale_prices)) {
    notes.push("Some prices are more than a week old and may have changed.");
  }

  return {
    item_count: items.length,
    ranking: ranked.map(({ totalCents: _t, ...r }) => r),
    best,
    split,
    not_found_anywhere: notFound,
    notes,
  };
}

function formatSize(p: ProductInfo): string {
  const value = String(Number(p.size_value));
  return p.size_unit === "pcs" ? `(${value} pcs)` : `${value}${p.size_unit}`;
}
