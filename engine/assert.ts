// Pure assertions: stored cart (Ajax API, read independently of the DOM) vs what the shopper sees.
// No browser APIs here, so the same logic can run in any runtime.

import { parseMoney } from './money.ts';
import type { Check, Market, MarketObservation, RequestedLine, Status, StoredCart, VisibleCart, VisibleLine } from './types.ts';

// Total check semantics (types.ts CaseChecks.total):
//   'required' (checks.total === true): the total must be shown, readable, carry a currency indicator and match.
//               Absent/unreadable/currency-less total => inconclusive (UNSUPPORTED), never PASS.
//   'optional' (default): checked when the surface shows a total. Absence is recorded, not failed.
//               Present but unreadable => inconclusive. Present without currency indicator => amount checked,
//               currency evidence recorded as unverified (line prices still carry the currency check).
//   'off'      (checks.total === false): not checked.
export type TotalMode = 'required' | 'optional' | 'off';

export function totalMode(flag: boolean | undefined): TotalMode {
  return flag === true ? 'required' : flag === false ? 'off' : 'optional';
}

// Failed checks that mean "could not observe", not "observed a mismatch".
export const INCONCLUSIVE_CHECKS = new Set(['visible.price.readable', 'visible.currency.indicator', 'visible.total.readable', 'visible.total.currency.indicator']);

export interface Verdict {
  status: Status;
  reason: string;
  checks: Check[];
}

export function verifyMarket(requested: Market, observedCountry: string | null, observedCurrency: string | null): MarketObservation {
  const verified = observedCountry === requested.country && observedCurrency === requested.currency;
  return {
    verified,
    observedCountry,
    observedCurrency,
    evidence: `in-session window.Shopify.country=${observedCountry ?? 'null'}, window.Shopify.currency.active=${observedCurrency ?? 'null'}`,
  };
}

function norm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchVisible(stored: StoredCart['lines'][number], visible: VisibleLine[], used: Set<number>): number {
  // Prefer the variant id from the line's product link; fall back to title + options.
  let idx = visible.findIndex((v, i) => !used.has(i) && v.variantId !== null && v.variantId === stored.variantId);
  if (idx >= 0) return idx;
  idx = visible.findIndex((v, i) => {
    if (used.has(i) || v.variantId !== null) return false;
    if (norm(v.title) !== norm(stored.productTitle)) return false;
    const opts = v.options.map(norm).join(' / ');
    return stored.variantTitle === 'Default Title' ? opts === '' : opts === norm(stored.variantTitle);
  });
  return idx;
}

export function classify(
  market: MarketObservation,
  requestedLines: Pick<RequestedLine, 'variantId' | 'quantity'>[],
  stored: StoredCart,
  visible: VisibleCart,
  options: { badge: boolean; total: TotalMode },
): Verdict {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const currency = market.observedCurrency ?? '';

  // 1. Requested vs stored (what the theme actually persisted).
  const wanted = new Map<number, number>();
  for (const l of requestedLines) wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + l.quantity);
  const storedQty = new Map<number, number>();
  for (const l of stored.lines) storedQty.set(l.variantId, (storedQty.get(l.variantId) ?? 0) + l.quantity);
  for (const [variantId, qty] of wanted) {
    const got = storedQty.get(variantId);
    if (got === undefined) {
      add('stored.variant', false, `requested variant ${variantId} not in stored cart (stored: ${[...storedQty.keys()].join(', ') || 'none'})`);
    } else {
      add('stored.variant', true, `variant ${variantId} stored`);
      add('stored.quantity', got === qty, got === qty ? `variant ${variantId} qty ${got}` : `variant ${variantId}: requested qty ${qty}, stored qty ${got}`);
    }
  }
  for (const variantId of storedQty.keys()) {
    if (!wanted.has(variantId)) add('stored.unexpected', false, `unexpected stored variant ${variantId}`);
  }

  // 2. Stored currency must equal the in-session verified market currency. No conversion, ever.
  add('stored.currency', stored.currency === currency, `stored cart currency ${stored.currency}, verified market currency ${currency}`);

  // 3. Visible lines vs stored lines.
  add('visible.lineCount', visible.lines.length === stored.lines.length, `stored ${stored.lines.length} line(s), visible ${visible.lines.length} line(s) in ${visible.surface}`);
  const used = new Set<number>();
  let unreadablePrice = false;
  for (const s of stored.lines) {
    const i = matchVisible(s, visible.lines, used);
    if (i < 0) {
      add('visible.line', false, `stored line ${s.productTitle} (${s.variantTitle}, variant ${s.variantId}) not visible`);
      continue;
    }
    used.add(i);
    const v = visible.lines[i];
    const opts = v.options.map(norm).join(' / ');
    const expectOpts = s.variantTitle === 'Default Title' ? '' : norm(s.variantTitle);
    add('visible.variant', opts === expectOpts, `variant ${s.variantId}: stored "${s.variantTitle}", visible "${v.options.join(' / ') || '(none)'}"`);
    add('visible.quantity', v.quantity === s.quantity, `variant ${s.variantId}: stored qty ${s.quantity}, visible qty ${v.quantity ?? 'unreadable'}`);
    const parsed = parseMoney(v.priceText, currency);
    v.parsed = parsed;
    if (parsed.amountMinor === null) {
      unreadablePrice = true;
      add('visible.price.readable', false, `variant ${s.variantId}: visible price unreadable (${parsed.error ?? 'unknown'}) text="${v.priceText ?? ''}"`);
      continue;
    }
    if (parsed.currencyCandidates.length === 0) {
      unreadablePrice = true;
      add('visible.currency.indicator', false, `variant ${s.variantId}: visible price "${v.priceText}" shows no currency indicator; currency cannot be verified`);
    } else {
      add('visible.currency', parsed.currencyCandidates.includes(currency), `variant ${s.variantId}: visible "${v.priceText}" indicates ${parsed.currencyCandidates.join('|')}, market ${currency}`);
    }
    add('visible.amount', parsed.amountMinor === s.finalLinePriceMinor, `variant ${s.variantId}: stored line ${s.finalLinePriceMinor} ${currency} minor, visible ${parsed.amountMinor}`);
  }

  // 4. Badge, only when the adapter declares one and the case expects it.
  if (options.badge) {
    const count = visible.badgeCount ?? 0;
    add('visible.badge', count === stored.itemCount, `stored item_count ${stored.itemCount}, badge ${visible.badgeCount === null ? 'absent' : visible.badgeCount}`);
  }

  // 5. Total (see TotalMode).
  if (options.total !== 'off') {
    const required = options.total === 'required';
    if (!visible.totalText) {
      if (required) add('visible.total.readable', false, `total required but not shown in ${visible.surface}; parity of the total cannot be verified`);
      else add('visible.total.absent', true, `no total shown in ${visible.surface}; total not checked (optional)`);
    } else {
      const t = parseMoney(visible.totalText, currency);
      if (t.amountMinor === null) {
        add('visible.total.readable', false, `visible total unreadable (${t.error ?? 'unknown'}) text="${visible.totalText}"`);
      } else {
        if (t.currencyCandidates.length === 0) {
          if (required) add('visible.total.currency.indicator', false, `visible total "${visible.totalText}" shows no currency indicator; total currency cannot be verified`);
          else add('visible.total.currency.unverified', true, `visible total "${visible.totalText}" shows no currency indicator; amount checked only (optional)`);
        } else {
          add('visible.total.currency', t.currencyCandidates.includes(currency), `visible total "${visible.totalText}" indicates ${t.currencyCandidates.join('|')}, market ${currency}`);
        }
        add('visible.total', t.amountMinor === stored.totalMinor, `stored total ${stored.totalMinor}, visible "${visible.totalText}" -> ${t.amountMinor}`);
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  const regressions = failed.filter((c) => !INCONCLUSIVE_CHECKS.has(c.name));
  if (regressions.length > 0) return { status: 'REGRESSION', reason: regressions.map((c) => c.detail).join('; '), checks };
  if (unreadablePrice || failed.length > 0) return { status: 'UNSUPPORTED', reason: failed.map((c) => c.detail).join('; '), checks };
  return { status: 'PASS', reason: `stored == visible across ${stored.lines.length} line(s), market ${market.observedCountry}/${currency} verified in-session`, checks };
}

// Live vs candidate: both must pass and their normalized observations must match.
export function comparePair(live: { status: Status; stored: StoredCart | null; visible: VisibleCart | null }, candidate: { status: Status; stored: StoredCart | null; visible: VisibleCart | null }): Verdict {
  const inconclusive: Status[] = ['ERROR', 'BLOCKED', 'UNSUPPORTED'];
  for (const s of inconclusive) {
    if (live.status === s || candidate.status === s) {
      return { status: s, reason: `pair inconclusive: live ${live.status}, candidate ${candidate.status}`, checks: [] };
    }
  }
  if (candidate.status === 'REGRESSION') return { status: 'REGRESSION', reason: `candidate regressed (live ${live.status})`, checks: [] };
  if (live.status === 'REGRESSION') return { status: 'REGRESSION', reason: 'live has a regression; candidate passes (fix candidate?)', checks: [] };
  const sig = (x: { stored: StoredCart | null; visible: VisibleCart | null }) =>
    JSON.stringify({
      cur: x.stored?.currency,
      total: x.stored?.totalMinor,
      lines: x.stored?.lines.map((l) => [l.variantId, l.quantity, l.finalLinePriceMinor]),
      vis: x.visible?.lines.map((l) => [l.quantity, l.parsed?.amountMinor ?? null]),
      badge: x.visible?.badgeCount,
    });
  const same = sig(live) === sig(candidate);
  return same
    ? { status: 'PASS', reason: 'live and candidate both pass with identical stored/visible observations', checks: [{ name: 'pair.equal', ok: true, detail: 'identical' }] }
    : { status: 'REGRESSION', reason: 'candidate diverges from live observations', checks: [{ name: 'pair.equal', ok: false, detail: `live ${sig(live)} vs candidate ${sig(candidate)}` }] };
}
