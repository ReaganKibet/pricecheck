// Run with:  npx tsx --test supabase/functions/_shared/logic.test.ts
//      or:   deno test supabase/functions/_shared/logic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseItem } from "./parse.ts";
import { compareBasket, type PriceRow, type ProductInfo, type Retailer } from "./compare.ts";

// ---------------------------------------------------------------- parseItem
test("size after the name", () => {
  const p = parseItem("unga 2kg");
  assert.equal(p.query, "unga");
  assert.deepEqual(p.size, { value: 2, unit: "kg" });
  assert.equal(p.quantity, 1);
});

test("quantity prefix and spaced size", () => {
  const p = parseItem("2 x Jogoo 2 kg");
  assert.equal(p.query, "jogoo");
  assert.equal(p.quantity, 2);
  assert.deepEqual(p.size, { value: 2, unit: "kg" });
});

test("spoken order: kilo 2, and quantity suffix", () => {
  const p = parseItem("sukari kilo 2 x3");
  assert.equal(p.query, "sukari");
  assert.equal(p.quantity, 3);
  assert.deepEqual(p.size, { value: 2, unit: "kg" });
});

test("litres and list bullets", () => {
  const p = parseItem("1. mafuta ya kupika 1 litre");
  assert.equal(p.query, "mafuta ya kupika");
  assert.deepEqual(p.size, { value: 1, unit: "l" });
});

test("half kilo becomes 500 g", () => {
  assert.deepEqual(parseItem("nusu kilo sukari").size, { value: 500, unit: "g" });
});

test("ml and decimals", () => {
  assert.deepEqual(parseItem("Brookside milk 500ml").size, { value: 500, unit: "ml" });
  assert.deepEqual(parseItem("oil 1,5 l").size, { value: 1.5, unit: "l" });
});

test("no size, plain number quantity", () => {
  const p = parseItem("3 mkate");
  assert.equal(p.query, "mkate");
  assert.equal(p.quantity, 3);
  assert.equal(p.size, undefined);
});

// ------------------------------------------------------------ compareBasket
const retailers: Retailer[] = [
  { id: 1, code: "naivas", name: "Naivas" },
  { id: 2, code: "carrefour", name: "Carrefour" },
  { id: 3, code: "quickmart", name: "Quickmart" },
];

const products: ProductInfo[] = [
  { id: 1, name: "Jogoo Maize Meal", brand: "Jogoo", category: "maize flour", size_value: 2, size_unit: "kg" },
  { id: 2, name: "Pembe Maize Flour", brand: "Pembe", category: "maize flour", size_value: 2, size_unit: "kg" },
  { id: 3, name: "Kabras Sugar", brand: "Kabras", category: "sugar", size_value: 2, size_unit: "kg" },
  { id: 4, name: "Fresh Fri Cooking Oil", brand: "Fresh Fri", category: "cooking oil", size_value: 1, size_unit: "l" },
  { id: 5, name: "Pembe Maize Flour", brand: "Pembe", category: "maize flour", size_value: 1, size_unit: "kg" },
];

const now = new Date("2026-11-19T10:00:00Z");
const fresh = "2026-11-18T10:00:00Z";
const row = (product_id: number, retailer_id: number, price: number, promo_price: number | null = null,
  observed_at = fresh): PriceRow => ({ product_id, retailer_id, price, promo_price, observed_at, source: "online" });

const prices: PriceRow[] = [
  row(1, 1, 150), row(1, 2, 155), row(1, 3, 157),
  row(2, 1, 140), row(2, 2, 145), row(2, 3, 139),
  row(3, 1, 335, 299), row(3, 2, 330), row(3, 3, 345),
  row(4, 1, 330), row(4, 2, 310), // not at Quickmart
  row(5, 3, 60),                  // 1kg Pembe must never stand in for 2kg
];

test("totals, ranking and promo prices", () => {
  const r = compareBasket(
    [{ product_id: 1, quantity: 2 }, { product_id: 3, quantity: 1 }],
    products, prices, retailers, { now },
  );
  // Naivas: 2*150 + 299 (promo) = 599 ; Carrefour: 2*155 + 330 = 640 ; Quickmart: 314 + 345 = 659
  assert.deepEqual(r.ranking.map((x) => [x.retailer_code, x.total_kes]),
    [["naivas", 599], ["carrefour", 640], ["quickmart", 659]]);
  assert.equal(r.best?.retailer_code, "naivas");
  assert.equal(r.best?.saving_vs_most_expensive_kes, 60);
  assert.equal(r.ranking[0].offers_used, 1);
});

test("store missing an item ranks below complete stores", () => {
  const r = compareBasket(
    [{ product_id: 1, quantity: 1 }, { product_id: 4, quantity: 1 }],
    products, prices, retailers, { now },
  );
  const last = r.ranking.at(-1)!;
  assert.equal(last.retailer_code, "quickmart");
  assert.equal(last.items_missing, 1);
  assert.equal(r.best?.retailer_code, "carrefour"); // 155 + 310 = 465 vs Naivas 480
});

test("split shop is only suggested when it saves enough", () => {
  const items = [{ product_id: 3, quantity: 1 }, { product_id: 4, quantity: 1 }];
  // Best single store: Naivas 299+330=629 vs Carrefour 330+310=640. Split: 299+310=609, saves 20.
  const small = compareBasket(items, products, prices, retailers, { now, splitThresholdKes: 200 });
  assert.equal(small.split?.saving_vs_best_kes, 20);
  assert.equal(small.split?.worth_it, false);
  const loose = compareBasket(items, products, prices, retailers, { now, splitThresholdKes: 10 });
  assert.equal(loose.split?.worth_it, true);
  assert.equal(loose.split?.stores.length, 2);
});

test("any-brand mode picks the cheapest same-size product, never a different size", () => {
  const r = compareBasket([{ product_id: 1, quantity: 1, any_brand: true }], products, prices, retailers, { now });
  const qm = r.ranking.find((x) => x.retailer_code === "quickmart")!;
  assert.equal(qm.lines[0].product_id, 2);   // Pembe 2kg at 139, not Pembe 1kg at 60
  assert.equal(qm.lines[0].substituted, true);
  assert.equal(qm.total_kes, 139);
});

test("no money rounding drift", () => {
  const p: PriceRow[] = [row(1, 1, 0.1), row(1, 2, 0.2)];
  const r = compareBasket([{ product_id: 1, quantity: 3 }], products, p, retailers.slice(0, 2), { now });
  assert.equal(r.ranking[0].total_kes, 0.3);
});

test("stale prices are flagged", () => {
  const p: PriceRow[] = [row(1, 1, 150, null, "2026-10-01T00:00:00Z")];
  const r = compareBasket([{ product_id: 1, quantity: 1 }], products, p, retailers.slice(0, 1), { now });
  assert.equal(r.ranking[0].has_stale_prices, true);
  assert.ok(r.notes.some((n) => n.includes("week old")));
});

test("item with no price anywhere is reported, no split offered", () => {
  const r = compareBasket(
    [{ product_id: 1, quantity: 1 }, { product_id: 999, quantity: 1 }],
    products, prices, retailers, { now },
  );
  assert.equal(r.not_found_anywhere.length, 1);
  assert.equal(r.split, null);
  assert.equal(r.best, null);
});
