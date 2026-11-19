// POST /get-offers
// Body: { "product_ids": [1, 5] }   (optional; omit to get all live offers)
// Returns live promotions on those products and on other brands of the
// same type and size, cheapest saving first.
import { db, error, guard, json, num } from "../_shared/http.ts";
import { labelFromRow } from "../_shared/match.ts";

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const ids: number[] = Array.isArray(body?.product_ids) ? body.product_ids.map(num) : [];

  const supabase = db();
  const cols = "id,name,brand,category,size_value,size_unit";

  let productFilter: number[] | null = null;
  if (ids.length > 0) {
    const { data: wanted, error: e1 } = await supabase.from("products").select("category").in("id", ids);
    if (e1) return error(e1.message, 500);
    const cats = [...new Set((wanted ?? []).map((p) => p.category as string))];
    const { data: related, error: e2 } = await supabase.from("products").select("id").in("category", cats);
    if (e2) return error(e2.message, 500);
    productFilter = (related ?? []).map((p) => num(p.id));
    if (productFilter.length === 0) return json({ offers: [] });
  }

  let q = supabase
    .from("latest_prices")
    .select("product_id,retailer_name,price,promo_price,promo_ends_at")
    .not("promo_price", "is", null);
  if (productFilter) q = q.in("product_id", productFilter);
  const { data: rows, error: e3 } = await q.limit(200);
  if (e3) return error(e3.message, 500);
  if (!rows || rows.length === 0) return json({ offers: [] });

  const { data: prods, error: e4 } = await supabase
    .from("products").select(cols).in("id", [...new Set(rows.map((r) => num(r.product_id)))]);
  if (e4) return error(e4.message, 500);
  const byId = new Map((prods ?? []).map((p) => [num(p.id), p]));

  const offers = rows
    .map((r) => {
      const p = byId.get(num(r.product_id));
      const price = num(r.price);
      const promo = num(r.promo_price);
      return {
        product_id: num(r.product_id),
        product: p ? labelFromRow(p) : `product ${r.product_id}`,
        on_your_list: ids.includes(num(r.product_id)),
        retailer: r.retailer_name,
        regular_price_kes: price,
        offer_price_kes: promo,
        saving_kes: Math.round((price - promo) * 100) / 100,
        ends: r.promo_ends_at,
      };
    })
    .sort((a, b) => Number(b.on_your_list) - Number(a.on_your_list) || b.saving_kes - a.saving_kes);

  return json({ offers });
});
