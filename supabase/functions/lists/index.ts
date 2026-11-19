// Saved shopping lists, keyed by phone number so WhatsApp and the web app
// see the same list.
//
// POST /lists   { "phone": "+2547...", "name": "My usual list",
//                 "items": [{ "product_id": 1, "quantity": 2, "any_brand": true }] }
//               -> saves (replaces) the list
// GET  /lists?phone=+2547...&name=My%20usual%20list
//               -> returns the list with product names
import { db, error, guard, json, num } from "../_shared/http.ts";
import { labelFromRow } from "../_shared/match.ts";

const PHONE = /^\+?\d{9,15}$/;

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  const supabase = db();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const phone = normalise(url.searchParams.get("phone"));
    const name = url.searchParams.get("name") ?? "My usual list";
    if (!phone) return error("phone is required");

    const { data: shopper } = await supabase.from("shoppers").select("id").eq("phone", phone).maybeSingle();
    if (!shopper) return json({ list: null });
    const { data: list } = await supabase.from("lists").select("id,name,updated_at")
      .eq("shopper_id", shopper.id).eq("name", name).maybeSingle();
    if (!list) return json({ list: null });

    const { data: rows, error: e } = await supabase
      .from("list_items")
      .select("product_id,quantity,any_brand,products(id,name,brand,category,size_value,size_unit)")
      .eq("list_id", list.id);
    if (e) return error(e.message, 500);

    return json({
      list: {
        name: list.name,
        updated_at: list.updated_at,
        items: (rows ?? []).map((r: Record<string, unknown>) => {
          const p = r.products as Record<string, unknown>;
          return {
            product_id: num(r.product_id),
            quantity: num(r.quantity),
            any_brand: Boolean(r.any_brand),
            label: p ? labelFromRow(p) : "",
          };
        }),
      },
    });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const phone = normalise(body?.phone);
    const name = String(body?.name ?? "My usual list");
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!phone) return error("a valid phone number is required");
    if (items.length === 0) return error("items are required");

    const { data: shopper, error: e1 } = await supabase.from("shoppers")
      .upsert({ phone }, { onConflict: "phone" }).select("id").single();
    if (e1) return error(e1.message, 500);

    const { data: list, error: e2 } = await supabase.from("lists")
      .upsert({ shopper_id: shopper.id, name, updated_at: new Date().toISOString() },
        { onConflict: "shopper_id,name" })
      .select("id").single();
    if (e2) return error(e2.message, 500);

    await supabase.from("list_items").delete().eq("list_id", list.id);
    const { error: e3 } = await supabase.from("list_items").insert(
      items.map((i: Record<string, unknown>) => ({
        list_id: list.id,
        product_id: num(i.product_id),
        quantity: i.quantity == null ? 1 : num(i.quantity),
        any_brand: Boolean(i.any_brand),
      })),
    );
    if (e3) return error(e3.message, 500);
    return json({ saved: true, name, items: items.length });
  }

  return error("use GET or POST", 405);
});

// Kenyan numbers: 07XX / 01XX / 2547XX / +2547XX -> +2547XX
function normalise(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s-]/g, "");
  if (/^0[17]\d{8}$/.test(s)) s = "+254" + s.slice(1);
  else if (/^254\d{9}$/.test(s)) s = "+" + s;
  return PHONE.test(s) ? (s.startsWith("+") ? s : "+" + s) : null;
}
