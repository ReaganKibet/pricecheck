// Turns one line of a shopping list ("2 x unga 2kg", "sukari kilo 2",
// "mafuta 1 litre") into a search query, a quantity and an optional size.
// Pure function: no network, no database, so it can be unit tested.

export type SizeUnit = "g" | "kg" | "ml" | "l" | "pcs";

export interface ParsedItem {
  raw: string;
  query: string;        // words left after removing quantity and size
  quantity: number;     // how many packs (default 1)
  size?: { value: number; unit: SizeUnit };
}

const UNIT_WORDS: Record<string, SizeUnit> = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml",
  l: "l", lt: "l", ltr: "l", ltrs: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  lita: "l",
  pcs: "pcs", pc: "pcs", pieces: "pcs",
};

const UNIT_PATTERN = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join("|");

// "2kg", "2 kg", "1.5 litres", "500ml"
const SIZE_AFTER = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "i");
// "kilo 2", "lita 1" (common in spoken Kenyan English and Swahili)
const SIZE_BEFORE = new RegExp(`\\b(${UNIT_PATTERN})\\s+(\\d+(?:[.,]\\d+)?)\\b`, "i");
// "half kilo", "nusu kilo"
const HALF = new RegExp(`\\b(half|nusu)\\s+(kilo|kg|litre|liter|lita|l)\\b`, "i");

// Quantity: "2 x ...", "x2", "2 packets", "3 pcs of" at the start
const QTY_PREFIX = /^\s*(\d+)\s*(?:x|×|\*|packets?|pkts?|pieces?|pcs?)?\s+(?=\D)/i;
const QTY_SUFFIX = /\s+(?:x|×|\*)\s*(\d+)\s*$/i;

export function parseItem(line: string): ParsedItem {
  let text = line.trim().replace(/^[-•*\d]+[.)]\s+/, ""); // drop list bullets "1. " "- "
  let quantity = 1;
  let size: ParsedItem["size"];

  const half = text.match(HALF);
  if (half) {
    const unit = UNIT_WORDS[half[2].toLowerCase()];
    size = unit === "kg" ? { value: 500, unit: "g" } : { value: 500, unit: "ml" };
    text = text.replace(HALF, " ");
  }

  if (!size) {
    const after = text.match(SIZE_AFTER);
    const before = after ? null : text.match(SIZE_BEFORE);
    if (after) {
      size = { value: toNumber(after[1]), unit: UNIT_WORDS[after[2].toLowerCase()] };
      text = text.replace(SIZE_AFTER, " ");
    } else if (before) {
      size = { value: toNumber(before[2]), unit: UNIT_WORDS[before[1].toLowerCase()] };
      text = text.replace(SIZE_BEFORE, " ");
    }
  }

  const pre = text.match(QTY_PREFIX);
  if (pre) {
    quantity = parseInt(pre[1], 10);
    text = text.replace(QTY_PREFIX, "");
  } else {
    const suf = text.match(QTY_SUFFIX);
    if (suf) {
      quantity = parseInt(suf[1], 10);
      text = text.replace(QTY_SUFFIX, "");
    }
  }

  const query = text
    .replace(/\b(ya|wa|of|the)\b\s*$/i, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return { raw: line, query, quantity: quantity > 0 ? quantity : 1, size };
}

function toNumber(s: string): number {
  return parseFloat(s.replace(",", "."));
}

/** Size in a base unit so 2 kg equals 2000 g. */
export function baseSize(value: number, unit: string): { value: number; unit: string } {
  if (unit === "kg") return { value: value * 1000, unit: "g" };
  if (unit === "l") return { value: value * 1000, unit: "ml" };
  return { value, unit };
}

export function sameSize(
  a: { value: number; unit: string },
  b: { value: number; unit: string },
): boolean {
  const x = baseSize(a.value, a.unit);
  const y = baseSize(b.value, b.unit);
  return x.unit === y.unit && Math.abs(x.value - y.value) < 0.001;
}
