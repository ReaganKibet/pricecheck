// Where every price source delivers its data: connectors, retailer feeds,
// manual checks and (later) receipts.
//
// POST /ingest-prices   prices
// {
//   "retailer": "naivas",
//   "source": "online",        // feed | receipt | manual | online | aggregator
//   "branch_code": null,       // optional, for branch-level prices
//   "observed_at": "2026-11-19T08:00:00Z",
//   "items": [{ "external_id": "naivas.online:12345", "name": "JOGOO MAIZE MEAL 2KG",
//               "price": 155, "promo_price": null, "promo_ends_at": null,
//               "barcode": "616...", "url": "https://...",
//               "product_id": 1 }]      // only for manual/feed: links straight to the catalogue
// }
// -> { listings, prices, held, matches_proposed }
//
// POST /ingest-prices   end-of-run report from a connector
// { "run_report": { "connector": "carrefour_site", "status": "ok", "items": 312, "held": 2, "error": null } }
// -> { healthy, reason, usual_items }
//
// GET /ingest-prices?retailer=carrefour&prefix=carrefour.ke:
// -> { listings: [{ external_id, url, matched }] }   known listings, for refresh runs
import { db, error, guard, json, num } from "../_shared/http.ts";

const SOURCES = ["feed", "receipt", "manual", "online", "aggregator"];
const TRUSTED = ["feed", "manual"]; // may link a listing to a catalogue product directly

interface IncomingItem {
  external_id: string;
  name: string;
  price: number;
  promo_price?: number | null;
  promo_ends_at?: string | null;
  barcode?: string | null;
  url?: string | null;
  product_id?: number | null;
}

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  const supabase = db();

  // ------------------------------------------------ known listings (refresh)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("retailer");
    const prefix = url.searchParams.get("prefix") ?? "";
    if (!code) return error("retailer is required");
    const { data: retailer } = await supabase.from("retailers").select("id").eq("code", code).maybeSingle();
    if (!retailer) return error(`unknown retailer "${code}"`);
    const { data, error: e } = await supabase
      .from("listings")
      .select("external_id,url,match_status")
      .eq("retailer_id", retailer.id)
      .like("external_id", `${prefix}%`)
      .neq("match_status", "rejected")
      .not("url", "is", null)
      .limit(20000);
    if (e) return error(e.message, 500);
    return json({
      listings: (data ?? []).map((l) => ({
        external_id: l.external_id,
        url: l.url,
        matched: l.match_status === "matched",
      })),
    });
  }

  if (req.method !== "POST") return error("use GET or POST", 405);
  const body = await req.json().catch(() => null);

  // ------------------------------------------------------------ run report
  if (body?.run_report) {
    const r = body.run_report;
    if (!r.connector || !["ok", "failed"].includes(r.status)) {
      return error("run_report needs connector and status ok|failed");
    }
    const { data, error: e } = await supabase.rpc("record_connector_run", {
      p_connector: String(r.connector),
      p_status: r.status,
      p_items: num(r.items ?? 0),
      p_held: num(r.held ?? 0),
      p_error: r.error ? String(r.error).slice(0, 500) : null,
    });
    if (e) return error(e.message, 500);
    return json(data);
  }

  // ---------------------------------------------------------------- prices
  const items: IncomingItem[] = Array.isArray(body?.items) ? body.items : [];
  const source = String(body?.source ?? "online");
  if (!body?.retailer || items.length === 0) return error("retailer and items are required");
  if (!SOURCES.includes(source)) return error(`source must be one of ${SOURCES.join(", ")}`);
  if (items.length > 5000) return error("send at most 5000 items per call");

  const bad = items.find((i) => !i.external_id || !i.name || !(num(i.price) > 0));
  if (bad) return error(`every item needs external_id, name and a price above 0 (see ${JSON.stringify(bad)})`);
  if (!TRUSTED.includes(source) && items.some((i) => i.product_id != null)) {
    return error(`product_id may only be sent with source ${TRUSTED.join(" or ")}`);
  }

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

  const now = new Date().toISOString();
  const row = (i: IncomingItem) => ({
    retailer_id: retailer.id,
    external_id: String(i.external_id),
    raw_name: i.name,
    barcode: i.barcode ?? null,
    url: i.url ?? null,
    updated_at: now,
  });

  // 1a. Ordinary listings. Existing matches are kept: product_id and
  //     match_status are not in the upsert.
  const plain = items.filter((i) => i.product_id == null);
  const linked = items.filter((i) => i.product_id != null);
  const listings: { id: number; external_id: string }[] = [];
  if (plain.length) {
    const { data, error: e2 } = await supabase.from("listings")
      .upsert(plain.map(row), { onConflict: "retailer_id,external_id" }).select("id,external_id");
    if (e2) return error(e2.message, 500);
    listings.push(...(data ?? []));
  }
  // 1b. Trusted sources that name the catalogue product: linked directly.
  if (linked.length) {
    const { data, error: e3 } = await supabase.from("listings")
      .upsert(
        linked.map((i) => ({
          ...row(i),
          product_id: num(i.product_id),
          match_status: "matched",
          match_confidence: 1,
        })),
        { onConflict: "retailer_id,external_id" },
      )
      .select("id,external_id");
    if (e3) return error(e3.message, 500);
    listings.push(...(data ?? []));
  }

  const idByExternal = new Map(listings.map((l) => [String(l.external_id), num(l.id)]));
  const observedAt = body.observed_at ?? now;

  // 2. Append prices. A database trigger holds any price that moved more
  //    than 40% since the last live one, so a scraping glitch never reaches shoppers.
  const { data: inserted, error: e4 } = await supabase.from("prices").insert(
    items.map((i) => ({
      listing_id: idByExternal.get(String(i.external_id)),
      branch_id: branchId,
      price: num(i.price),
      promo_price: i.promo_price == null ? null : num(i.promo_price),
      promo_ends_at: i.promo_ends_at ?? null,
      source,
      observed_at: observedAt,
    })),
  ).select("status");
  if (e4) return error(e4.message, 500);
  const held = (inserted ?? []).filter((p) => p.status === "held").length;

  // 3. Propose catalogue matches for new listings
  const { data: proposed, error: e5 } = await supabase.rpc("propose_listing_matches");
  if (e5) return error(e5.message, 500);

  return json({ listings: listings.length, prices: items.length, held, matches_proposed: proposed });
});
