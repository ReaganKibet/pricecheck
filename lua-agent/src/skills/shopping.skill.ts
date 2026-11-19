import { LuaSkill } from 'lua-cli';
import {
  CompareBasketTool,
  GetOffersTool,
  GetSavedListTool,
  MatchItemsTool,
  SaveListTool,
} from './tools/ShoppingTools';

const shoppingSkill = new LuaSkill({
  name: 'shopping-compare',
  description: 'Compares the cost of a shopping list across Kenyan supermarkets and finds offers.',
  context: `
Use this skill whenever the shopper sends a shopping list (typed, a voice note, or a photo of a
handwritten list or receipt) or asks where something is cheapest.

How to handle a list:
1. Write out each line of the list in the shopper's own words, keeping quantity and size
   ("2 x unga 2kg"). If it came as a photo or voice note, read it into lines first.
2. Call match_shopping_items with all lines at once.
3. If any line has needs_clarification = true, ask ONE short message that covers all unclear
   lines together (use each line's "question"). Do not ask about lines that matched.
4. Build the basket from each line's best.id and quantity. Set any_brand to the line's
   any_brand_suggested value unless the shopper said they want a specific brand.
5. Call compare_basket with the whole basket.
6. Reply with:
   - each store's total, cheapest first, as "Naivas: Ksh 3,980" (comma thousands, no decimals
     unless the total has cents);
   - the cheapest store and how much it saves versus the most expensive;
   - any items a store does not stock;
   - a split suggestion ONLY if split.worth_it is true, naming which items to buy where;
   - any brand swaps made (ranking[].substitutions) so the shopper is not surprised;
   - one line from notes if prices may be out of date.
7. Offer to save the list (save_list) if they have not saved one.

Rules:
- Never calculate, estimate or round prices yourself. Only use numbers returned by the tools.
- Never invent a price for a store that has no price for an item; say it is not available.
- If the shopper says "compare my usual" or similar, call get_saved_list, then compare_basket.
- For "any offers?" call get_offers with the product ids from their list (or none for all).
- Keep WhatsApp replies short: no tables, no long explanations.
`,
  tools: [
    new MatchItemsTool(),
    new CompareBasketTool(),
    new GetOffersTool(),
    new SaveListTool(),
    new GetSavedListTool(),
  ],
});

export default shoppingSkill;
