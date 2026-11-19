// POST /ingest-prices   (called by the scrapers, and later by retailer feeds)
// Body: {
//   "retailer": "naivas",
//   "source": "online",                 // online | feed | manual | receipt
//   "branch_code": null,                // optional, for branch-level prices
//   "observed_at": "2026-11-19T08:00:00Z",
//   "items": [{ "external_id": "12345", "name": "JOGOO MAIZE MEAL 2KG",
//               "price": 155, "promo_price": null, "promo_ends_at": null,
//               "barcode": "616...", "url": "https://..." }]
// }
// Upserts the store's listings, appends a price row for each, then proposes
// catalogue matches for anything new (barcode = auto, name = for review).
import { db, error, guard, json, num } from "../_shared/http.ts";

interface IncomingItem {
  external_id: string;
  name: string;
  price: number;
  promo_price?: number | null;
  promo_ends_at?: string | null;
  barcode?: string | null;
  url?: string | null;
}

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  if (req.method !== "POST") return error("use POST", 405);

  const body = await req.json().catch(() => null);
  const items: IncomingItem[] = Array.isArray(body?.items) ? body.items : [];
  const source = String(body?.source ?? "online");
  if (!body?.retailer || items.length === 0) return error("retailer and items are required");
  if (!["online", "feed", "manual", "receipt"].includes(source)) return error("bad source");
  if (items.length > 5000) return error("send at most 5000 items per call");

  const bad = items.find((i) => !i.external_id || !i.name || !(num(i.price) > 0));
  if (bad) return error(`every item needs external_id, name and a price above 0 (see ${JSON.stringify(bad)})`);

  const supabase = db();
  const { data: retailer, error: e1 } = await supabase
    .from("retailers").select("id").eq("code", body.retailer).single();
  if (e1 || !retailer) return error(`unknown retailer "${body.retailer}"`);

  let branchId: number | null = null;
  if (body.branch_code) {
    const { data: branch } = await supabase.from("branches").select("id")
      .eq("retailer_id", retailer.id).eq("code", body.branch_code).maybeSingle();
    if (!branch) return error(`unknown branch "${body.branch_code}" for ${body.retailer}`);
    branchId = branch.id;
  }

  // 1. Upsert listings. Existing matches are kept because product_id and
  //    match_status are not part of the upsert.
  const { data: listings, error: e2 } = await supabase
    .from("listings")
    .upsert(
      items.map((i) => ({
        retailer_id: retailer.id,
        external_id: String(i.external_id),
        raw_name: i.name,
        barcode: i.barcode ?? null,
        url: i.url ?? null,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "retailer_id,external_id" },
    )
    .select("id,external_id");
  if (e2) return error(e2.message, 500);

  const idByExternal = new Map((listings ?? []).map((l) => [String(l.external_id), num(l.id)]));
  const observedAt = body.observed_at ?? new Date().toISOString();

  // 2. Append prices
  const { error: e3 } = await supabase.from("prices").insert(
    items.map((i) => ({
      listing_id: idByExternal.get(String(i.external_id)),
      branch_id: branchId,
      price: num(i.price),
      promo_price: i.promo_price == null ? null : num(i.promo_price),
      promo_ends_at: i.promo_ends_at ?? null,
      source,
      observed_at: observedAt,
    })),
  );
  if (e3) return error(e3.message, 500);

  // 3. Propose matches for new listings
  const { data: proposed, error: e4 } = await supabase.rpc("propose_listing_matches");
  if (e4) return error(e4.message, 500);

  return json({ listings: listings?.length ?? 0, prices: items.length, matches_proposed: proposed });
});
