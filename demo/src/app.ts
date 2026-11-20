// PriceCheck demo UI: a WhatsApp-style chat on the left, the comparison the
// agent is working from on the right. No server: everything runs in the page.
import type { MatchResult } from "../../supabase/functions/_shared/match.ts";
import type { CompareResult, RetailerResult } from "../../supabase/functions/_shared/compare.ts";
import { compare, matchItems, productLabel, splitList } from "./engine.ts";

interface ListItem {
  key: number;
  input: string;
  product_id: number;
  quantity: number;
  any_brand: boolean;
}

const SAMPLES = [
  "unga 2kg\nsukari kilo 2\nmafuta ya kupika 1 litre\ntray ya mayai\nmaziwa 500ml x4",
  "2 x Jogoo 2kg, Kabras sugar 2kg, Kimbo 1kg, mkate x2",
  "Exe 2kg, Mumias sugar, Elianto 1l, Brookside milk 500ml x6",
];

let list: ListItem[] = [];
let nextKey = 1;
let lastResult: CompareResult | null = null;
let expanded: string | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const chat = $("#chat");
const input = $<HTMLTextAreaElement>("#msg");
const panel = $("#panel");

// ------------------------------------------------------------------ helpers
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const ksh = (n: number) =>
  "Ksh " + n.toLocaleString("en-KE", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

/** WhatsApp formatting: *bold* and line breaks. */
const waFormat = (s: string) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/\n/g, "<br>");

const time = () => new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });

function bubble(who: "me" | "bot", html: string, extra?: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.innerHTML = `<div class="text">${html}</div><span class="time">${time()}${who === "me" ? ' <span class="ticks">✓✓</span>' : ""}</span>`;
  if (extra) el.insertBefore(extra, el.querySelector(".time"));
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function typing(then: () => void) {
  const el = document.createElement("div");
  el.className = "bubble bot typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  setTimeout(() => {
    el.remove();
    then();
  }, 650);
}

// ------------------------------------------------------- the agent's reply
// The live Lua agent writes its own wording; this template follows the
// rules in its Shopping skill so the demo reads the same way.
function replyFor(r: CompareResult): string {
  if (r.ranking.length === 0) return "I don't have prices for those items yet.";
  const lines: string[] = [];
  lines.push(`Your list, ${r.item_count} item${r.item_count === 1 ? "" : "s"}:`);
  r.ranking.forEach((s, i) => {
    const tag = r.best && s.retailer_code === r.best.retailer_code ? " (cheapest)" : "";
    const miss = s.items_missing ? `, missing ${s.items_missing}` : "";
    const row = `${s.retailer_name}: ${ksh(s.total_kes)}${tag}${miss}`;
    lines.push(i === 0 && tag ? `*${row}*` : row);
  });

  if (r.best && r.best.saving_vs_most_expensive_kes > 0) {
    lines.push("");
    lines.push(`${r.best.retailer_name} saves you ${ksh(r.best.saving_vs_most_expensive_kes)} vs ${r.best.most_expensive_retailer}.`);
  }

  const best = r.ranking[0];
  const offers = best.lines.filter((l) => l.on_offer);
  for (const o of offers) {
    lines.push(`Offer: ${o.product_name} is ${ksh(o.unit_price_kes)} at ${best.retailer_name} (usually ${ksh(o.regular_price_kes)}).`);
  }
  const swaps = best.lines.filter((l) => l.substituted);
  if (swaps.length) {
    lines.push(`Cheaper brand picked at ${best.retailer_name}: ${swaps.map((l) => l.product_name).join(", ")}.`);
  }
  for (const s of r.ranking.filter((x) => x.items_missing)) {
    lines.push(`${s.retailer_name} doesn't stock ${s.missing.map((m) => m.product_name).join(", ")}.`);
  }

  if (r.split && r.split.saving_vs_best_kes > 0) {
    lines.push("");
    if (r.split.worth_it) {
      lines.push(`*Tip:* split your shop to save ${ksh(r.split.saving_vs_best_kes)} more:`);
      for (const s of r.split.stores) lines.push(`• ${s.retailer_name}: ${s.items.join(", ")}`);
    } else {
      lines.push(`Splitting between stores would only save ${ksh(r.split.saving_vs_best_kes)}, so one trip is best.`);
    }
  }
  if (r.notes.length) lines.push("", r.notes[0]);
  lines.push("", "Want me to save this as your usual list?");
  return lines.join("\n");
}

// ------------------------------------------------------------ conversation
function send(text: string) {
  const lines = splitList(text);
  if (lines.length === 0) return;
  bubble("me", waFormat(text.trim()));
  input.value = "";
  autosize();

  const results = matchItems(lines);
  const matched = results.filter((m) => m.best);
  const unclear = results.filter((m) => !m.best);

  for (const m of matched) addItem(m.input, m.best!.id, m.quantity, m.any_brand_suggested);

  // Like the live agent: ask about unclear lines first, compare once they're answered.
  const answerable = unclear.filter((m) => choicesFor(m).length > 0);
  waitingFor = answerable.length;
  typing(() => {
    if (unclear.length) ask(unclear);
    if (waitingFor === 0 && list.length) refresh(true);
  });
}

let waitingFor = 0;

function addItem(inputText: string, product_id: number, quantity: number, any_brand: boolean) {
  const existing = list.find((i) => i.product_id === product_id && i.any_brand === any_brand);
  if (existing) existing.quantity += quantity;
  else list.push({ key: nextKey++, input: inputText, product_id, quantity, any_brand });
}

/** Clarifying questions, with tappable answers like WhatsApp reply buttons. */
function ask(unclear: MatchResult[]) {
  for (const m of unclear) {
    const box = document.createElement("div");
    box.className = "choices";
    const options = choicesFor(m);
    for (const o of options) {
      const b = document.createElement("button");
      b.textContent = o.label;
      b.onclick = () => {
        box.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = true));
        b.classList.add("picked");
        bubble("me", esc(o.label));
        addItem(m.input, o.id, m.quantity, o.any_brand);
        waitingFor = Math.max(0, waitingFor - 1);
        if (waitingFor === 0) typing(() => refresh(true));
      };
      box.appendChild(b);
    }
    const text = m.question ?? `What did you mean by "${m.input}"?`;
    bubble("bot", waFormat(options.length ? text : `${text}\n\n(This demo knows 12 everyday products; the live catalogue will have 300+.)`), options.length ? box : undefined);
  }
}

function choicesFor(m: MatchResult): { id: number; label: string; any_brand: boolean }[] {
  if (m.alternatives.length === 0) return [];
  const categories = [...new Set(m.alternatives.map((a) => a.category))];
  // "unga": maize or wheat? Offer the kinds, cheapest brand of each.
  if (categories.length > 1 && /do you mean/.test(m.question ?? "")) {
    return categories.map((c) => {
      const first = m.alternatives.find((a) => a.category === c)!;
      return { id: first.id, label: c[0].toUpperCase() + c.slice(1), any_brand: true };
    });
  }
  return m.alternatives.slice(0, 3).map((a) => ({ id: a.id, label: a.label, any_brand: false }));
}

function refresh(withReply: boolean) {
  if (list.length === 0) {
    lastResult = null;
    renderPanel();
    return;
  }
  lastResult = compare(list.map(({ product_id, quantity, any_brand }) => ({ product_id, quantity, any_brand })));
  if (!expanded || !lastResult.ranking.some((r) => r.retailer_code === expanded)) {
    expanded = lastResult.ranking[0]?.retailer_code ?? null;
  }
  if (withReply) bubble("bot", waFormat(replyFor(lastResult)));
  renderPanel();
}

// ------------------------------------------------------------- right panel
function renderPanel() {
  if (!lastResult) {
    panel.innerHTML = `
      <div class="empty">
        <h2>Send a list to see the comparison</h2>
        <p>Type it the way you'd text it: <i>unga 2kg, sukari kilo 2, tray ya mayai</i>. Or tap a sample list under the chat.</p>
      </div>`;
    return;
  }
  const r = lastResult;
  const max = Math.max(...r.ranking.map((s) => s.total_kes));
  panel.innerHTML = `
    <section>
      <div class="section-head">
        <h2>Store totals</h2>
        ${r.best ? `<span class="saving">Save ${ksh(r.best.saving_vs_most_expensive_kes)} at ${esc(r.best.retailer_name)}</span>` : ""}
      </div>
      <div class="stores">${r.ranking.map((s) => storeCard(s, max)).join("")}</div>
      ${splitCard(r)}
    </section>
    <section>
      <div class="section-head">
        <h2>Your list</h2>
        <button class="link" id="clear">Start a new list</button>
      </div>
      <ul class="items">${list.map(itemRow).join("")}</ul>
    </section>`;

  panel.querySelectorAll<HTMLElement>(".store").forEach((el) => {
    el.onclick = () => {
      expanded = expanded === el.dataset.code ? null : el.dataset.code!;
      renderPanel();
    };
  });
  panel.querySelectorAll<HTMLInputElement>("input[data-anybrand]").forEach((el) => {
    el.onchange = () => {
      const item = list.find((i) => i.key === Number(el.dataset.anybrand))!;
      item.any_brand = el.checked;
      refresh(false);
    };
  });
  panel.querySelectorAll<HTMLButtonElement>("button[data-remove]").forEach((el) => {
    el.onclick = () => {
      list = list.filter((i) => i.key !== Number(el.dataset.remove));
      refresh(false);
    };
  });
  panel.querySelectorAll<HTMLButtonElement>("button[data-qty]").forEach((el) => {
    el.onclick = () => {
      const item = list.find((i) => i.key === Number(el.dataset.qty))!;
      item.quantity = Math.max(1, item.quantity + Number(el.dataset.step));
      refresh(false);
    };
  });
  $("#clear").onclick = () => {
    list = [];
    waitingFor = 0;
    bubble("bot", "List cleared. Send me a new one whenever you're ready.");
    refresh(false);
  };
}

function storeCard(s: RetailerResult, max: number): string {
  const best = lastResult?.best?.retailer_code === s.retailer_code;
  const open = expanded === s.retailer_code;
  const pct = max ? Math.max(8, (s.total_kes / max) * 100) : 0;
  const badges = [
    best ? `<span class="badge best">Cheapest</span>` : "",
    s.offers_used ? `<span class="badge offer">${s.offers_used} offer${s.offers_used > 1 ? "s" : ""}</span>` : "",
    s.items_missing ? `<span class="badge miss">${s.items_missing} missing</span>` : "",
  ].join("");
  const rows = s.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.product_name)}${l.substituted ? ' <span class="tag swap">cheaper brand</span>' : ""}${l.on_offer ? ` <span class="tag offer">offer, usually ${ksh(l.regular_price_kes)}</span>` : ""}</td>
        <td class="num">${l.quantity} × ${ksh(l.unit_price_kes)}</td>
        <td class="num">${ksh(l.line_total_kes)}</td></tr>`,
    )
    .join("");
  const missing = s.missing.map((m) => `<tr class="missing"><td colspan="3">Not stocked: ${esc(m.product_name)}</td></tr>`).join("");
  return `
    <div class="store ${best ? "is-best" : ""} ${open ? "open" : ""}" data-code="${s.retailer_code}">
      <div class="store-top">
        <span class="name">${esc(s.retailer_name)}</span>
        <span class="badges">${badges}</span>
        <span class="total">${ksh(s.total_kes)}</span>
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${open ? `<table class="lines">${rows}${missing}</table>` : ""}
    </div>`;
}

function splitCard(r: CompareResult): string {
  if (!r.split || r.split.stores.length < 2) return "";
  if (!r.split.worth_it) {
    return `<p class="split muted">Splitting the shop across stores would save only ${ksh(r.split.saving_vs_best_kes)}, under the Ksh 200 minimum, so PriceCheck recommends one trip.</p>`;
  }
  return `<div class="split worth"><b>Split and save ${ksh(r.split.saving_vs_best_kes)} more</b>${r.split.stores
    .map((s) => `<div>${esc(s.retailer_name)}: ${s.items.map(esc).join(", ")}</div>`)
    .join("")}</div>`;
}

function itemRow(i: ListItem): string {
  return `<li>
    <div class="item-main">
      <span class="label">${esc(productLabel(i.product_id))}</span>
      <span class="from">you wrote "${esc(i.input)}"</span>
    </div>
    <div class="qty">
      <button data-qty="${i.key}" data-step="-1" aria-label="Fewer">−</button>
      <span>${i.quantity}</span>
      <button data-qty="${i.key}" data-step="1" aria-label="More">+</button>
    </div>
    <label class="anybrand" title="Let PriceCheck pick the cheapest brand of the same size">
      <input type="checkbox" data-anybrand="${i.key}" ${i.any_brand ? "checked" : ""}> any brand
    </label>
    <button class="remove" data-remove="${i.key}" aria-label="Remove">×</button>
  </li>`;
}

// ------------------------------------------------------------------- setup
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

$("#send").onclick = () => send(input.value);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});
input.addEventListener("input", autosize);

const samples = $("#samples");
SAMPLES.forEach((s, i) => {
  const b = document.createElement("button");
  b.textContent = `Sample list ${i + 1}`;
  b.title = s.replace(/\n/g, ", ");
  b.onclick = () => send(s);
  samples.appendChild(b);
});

bubble(
  "bot",
  waFormat(
    "Hi! I'm *PriceCheck*. Send me your shopping list, typed however you like, and I'll tell you which supermarket is cheapest for the whole lot: Naivas, Carrefour, Quickmart or Chandarana.",
  ),
);
renderPanel();
