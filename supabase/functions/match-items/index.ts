// POST /match-items
// Body: { "items": ["unga 2kg", "2 x sukari", "mafuta 1 litre"] }
// Returns the best catalogue product for each line, or a question to ask.
import { db, error, guard, json, num } from "../_shared/http.ts";
import { parseItem } from "../_shared/parse.ts";
import { type Candidate, chooseMatch } from "../_shared/match.ts";

Deno.serve(async (req) => {
  const denied = guard(req);
  if (denied) return denied;
  if (req.method !== "POST") return error("use POST", 405);

  const body = await req.json().catch(() => null);
  const lines: unknown = body?.items;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 60) {
    return error("items must be a list of 1 to 60 strings");
  }

  const supabase = db();
  const results = await Promise.all(
    lines.map(async (line) => {
      const parsed = parseItem(String(line));
      const query = parsed.query || String(line);
      const { data, error: e } = await supabase.rpc("search_products", { q: query, max_results: 8 });
      if (e) throw e;
      const candidates: Candidate[] = (data ?? []).map((c: Record<string, unknown>) => ({
        id: num(c.id),
        name: String(c.name),
        brand: c.brand ? String(c.brand) : null,
        category: String(c.category),
        size_value: num(c.size_value),
        size_unit: String(c.size_unit),
        score: num(c.score),
      }));
      return chooseMatch(parsed, candidates);
    }),
  ).catch((e) => e as Error);

  if (results instanceof Error) return error(results.message, 500);
  return json({ items: results });
});
