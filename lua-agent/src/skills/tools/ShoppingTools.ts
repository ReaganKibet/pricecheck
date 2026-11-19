import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { callPriceApi } from '../../services/PriceApi';

const basketItem = z.object({
  product_id: z.number().int().describe('Catalogue product id from match_shopping_items'),
  quantity: z.number().positive().default(1).describe('Number of packs'),
  any_brand: z
    .boolean()
    .default(false)
    .describe('True when the shopper did not name a brand, so the cheapest same-size product may be used'),
});

/** Step 1: turn the shopper's list lines into catalogue products. */
export class MatchItemsTool implements LuaTool {
  name = 'match_shopping_items';
  description =
    'Match each line of a shopping list (as the shopper wrote or said it, e.g. "unga 2kg", "2 x sukari") ' +
    'to catalogue products. Returns the best product per line, alternatives, and a question when a line is unclear.';
  label = { running: 'Reading your list', done: 'Read your list' };
  inputSchema = z.object({
    items: z
      .array(z.string().min(1))
      .min(1)
      .max(60)
      .describe('One entry per list line, in the shopper’s own words, including quantity and size'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    return callPriceApi('match-items', { body: { items: input.items } });
  }
}

/** Step 2: compare the matched basket across supermarkets. */
export class CompareBasketTool implements LuaTool {
  name = 'compare_basket';
  description =
    'Compare the total cost of a basket across Naivas, Carrefour, Quickmart and Chandarana. ' +
    'Returns each store total, the cheapest complete store, missing items, offers used, and whether splitting the shop is worth it. ' +
    'Always use these numbers exactly; never calculate prices yourself.';
  label = { running: 'Comparing supermarket prices', done: 'Compared supermarket prices' };
  inputSchema = z.object({
    items: z.array(basketItem).min(1).max(80),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const result = await callPriceApi<Record<string, unknown>>('compare-basket', {
      body: { items: input.items },
    });
    // Keep the reply small for the model: drop per-line detail beyond what it needs.
    const ranking = (result.ranking as Array<Record<string, unknown>>).map((r) => ({
      store: r.retailer_name,
      total_kes: r.total_kes,
      items_missing: r.items_missing,
      missing: r.missing,
      offers_used: r.offers_used,
      has_stale_prices: r.has_stale_prices,
      substitutions: (r.lines as Array<Record<string, unknown>>)
        .filter((l) => l.substituted)
        .map((l) => l.product_name),
    }));
    return { ...result, ranking };
  }
}

/** Live promotions on the shopper's items and on other brands of the same type. */
export class GetOffersTool implements LuaTool {
  name = 'get_offers';
  description = 'List live supermarket offers on the given products and on other brands of the same type and size.';
  label = 'Checked this week’s offers';
  inputSchema = z.object({
    product_ids: z.array(z.number().int()).max(80).optional(),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    return callPriceApi('get-offers', { body: { product_ids: input.product_ids ?? [] } });
  }
}

async function shopperPhone(): Promise<string> {
  const user = await User.get();
  const phone = user?._luaProfile?.mobileNumbers?.[0];
  if (!phone) throw new Error('No phone number on this conversation; saved lists need WhatsApp or a signed-in user.');
  return phone;
}

/** Save the shopper's list so they can say "compare my usual" next time. */
export class SaveListTool implements LuaTool {
  name = 'save_list';
  description = 'Save the shopper’s matched list under a name (default "My usual list"), replacing any list with that name.';
  label = 'Saved your list';
  inputSchema = z.object({
    name: z.string().max(60).optional(),
    items: z.array(basketItem).min(1).max(80),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const phone = await shopperPhone();
    return callPriceApi('lists', { body: { phone, name: input.name, items: input.items } });
  }
}

/** Load a saved list, ready to pass to compare_basket. */
export class GetSavedListTool implements LuaTool {
  name = 'get_saved_list';
  description = 'Load the shopper’s saved list (default "My usual list"). Returns null if they have none.';
  label = 'Loaded your saved list';
  inputSchema = z.object({
    name: z.string().max(60).optional(),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const phone = await shopperPhone();
    return callPriceApi('lists', {
      method: 'GET',
      query: { phone, name: input.name ?? 'My usual list' },
    });
  }
}
