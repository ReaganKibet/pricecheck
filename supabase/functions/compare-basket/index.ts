// POST /compare-basket
// Body: { "items": [{ "product_id": 1, "quantity": 2, "any_brand": true }],
//         "split_threshold_kes": 200 }
// Returns totals per supermarket, the best single store, and whether
// splitting the shop is worth it. See _shared/compare.ts for the rules.
import { db, error, guard, json, num } from "../_shared/http.ts";
import { type BasketItem, compareBasket, type PriceRow, type ProductInfo } from "../_shared/compare.ts";

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  if (req.method !== "POST") return error("use POST", 405);

  const body = await req.json().catch(() => null);
  const raw: unknown = body?.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 80) {
    return error("items must be a list of 1 to 80 { product_id, quantity }");
  }
  const items: BasketItem[] = raw.map((i: Record<string, unknown>) => ({
    product_id: num(i.product_id),
    quantity: i.quantity == null ? 1 : num(i.quantity),
    any_brand: Boolean(i.any_brand),
  }));
  if (items.some((i) => !Number.isInteger(i.product_id) || !(i.quantity > 0))) {
    return error("each item needs a whole-number product_id and a quantity above 0");
  }

  const supabase = db();
  const cols = "id,name,brand,category,size_value,size_unit";

  // Requested products, plus same-category products for any-brand items
  const requestedIds = [...new Set(items.map((i) => i.product_id))];
  const { data: requested, error: e1 } = await supabase.from("products").select(cols).in("id", requestedIds);
  if (e1) return error(e1.message, 500);

  const anyBrandCategories = [...new Set(
    (requested ?? [])
      .filter((p) => items.some((i) => i.any_brand && i.product_id === p.id))
      .map((p) => p.category as string),
  )];
  let extra: typeof requested = [];
  if (anyBrandCategories.length > 0) {
    const { data, error: e2 } = await supabase.from("products").select(cols).in("category", anyBrandCategories);
    if (e2) return error(e2.message, 500);
    extra = data ?? [];
  }

  const productMap = new Map<number, ProductInfo>();
  for (const p of [...(requested ?? []), ...(extra ?? [])]) {
    productMap.set(num(p.id), {
      id: num(p.id),
      name: String(p.name),
      brand: p.brand ? String(p.brand) : null,
      category: String(p.category),
      size_value: num(p.size_value),
      size_unit: String(p.size_unit),
    });
  }
  const products = [...productMap.values()];

  const { data: priceRows, error: e3 } = await supabase
    .from("latest_prices")
    .select("product_id,retailer_id,price,promo_price,observed_at,source")
    .in("product_id", products.map((p) => p.id));
  if (e3) return error(e3.message, 500);

  const { data: retailers, error: e4 } = await supabase
    .from("retailers").select("id,code,name").eq("active", true).order("id");
  if (e4) return error(e4.message, 500);

  const prices: PriceRow[] = (priceRows ?? []).map((r) => ({
    product_id: num(r.product_id),
    retailer_id: num(r.retailer_id),
    price: num(r.price),
    promo_price: r.promo_price == null ? null : num(r.promo_price),
    observed_at: String(r.observed_at),
    source: String(r.source),
  }));

  const result = compareBasket(
    items,
    products,
    prices,
    (retailers ?? []).map((r) => ({ id: num(r.id), code: String(r.code), name: String(r.name) })),
    { splitThresholdKes: body?.split_threshold_kes == null ? 200 : num(body.split_threshold_kes) },
  );
  return json(result);
});
