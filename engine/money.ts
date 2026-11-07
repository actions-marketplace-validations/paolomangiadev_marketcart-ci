// Locale-tolerant money parsing WITHOUT currency conversion.
// Amounts are integers in ISO 4217 minor units of the currency being checked (EUR 24.00 -> 2400, JPY 7,800 -> 7800).

import type { ParsedMoney } from './types.ts';

const EXPONENT: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function minorExponent(currency: string): number {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

// Shopify's Ajax cart API reports every currency scaled by 100 ("cents-like"), including zero-decimal currencies.
// ASSUMPTION (community-reported, not confirmed in official docs on 2026-11-06): must be confirmed on a live JPY store.
export function shopifyCentsToIsoMinor(value: number, currency: string): number {
  const exp = minorExponent(currency);
  return Math.round((value * 10 ** exp) / 100);
}

// Symbol -> candidate ISO codes. Ambiguous symbols map to several currencies; we never guess a single one.
const SYMBOLS: [string, string[]][] = [
  ['US$', ['USD']], ['CA$', ['CAD']], ['C$', ['CAD']], ['A$', ['AUD']], ['AU$', ['AUD']], ['NZ$', ['NZD']], ['HK$', ['HKD']], ['S$', ['SGD']], ['R$', ['BRL']], ['MX$', ['MXN']],
  ['€', ['EUR']], ['£', ['GBP']], ['¥', ['JPY', 'CNY']], ['￥', ['JPY', 'CNY']], ['₩', ['KRW']], ['₹', ['INR']], ['₺', ['TRY']], ['₽', ['RUB']], ['₪', ['ILS']], ['₫', ['VND']], ['zł', ['PLN']], ['Kč', ['CZK']],
  ['kr', ['SEK', 'NOK', 'DKK', 'ISK']], ['Fr.', ['CHF']], ['CHF', ['CHF']],
  ['$', ['USD', 'CAD', 'AUD', 'NZD', 'MXN', 'SGD', 'HKD', 'CLP', 'COP', 'ARS']],
];

const ISO_CODE = /\b([A-Z]{3})\b/g;
const KNOWN_ISO = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'KRW', 'INR', 'BRL', 'MXN', 'SGD', 'HKD', 'TRY', 'ILS', 'AED', 'SAR', 'ZAR', 'KWD', 'BHD', 'VND', 'CLP', 'ISK', 'RON', 'BGN']);

export function currencyCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ISO_CODE)) {
    if (KNOWN_ISO.has(m[1])) found.add(m[1]);
  }
  let rest = text.replace(ISO_CODE, ' ');
  for (const [sym, codes] of SYMBOLS) {
    if (rest.includes(sym)) {
      codes.forEach((c) => found.add(c));
      rest = rest.split(sym).join(' '); // longest symbols first, so "US$" does not also count as bare "$"
    }
  }
  return [...found];
}

// Parse the numeric part. Decimal separator is decided by the expected currency's exponent, never by guessing a locale:
// the last separator is decimal only if exactly `exp` digits follow it.
export function parseMoney(text: string | null, expectedCurrency: string): ParsedMoney {
  if (!text || !text.trim()) return { amountMinor: null, currencyCandidates: [], error: 'empty price text' };
  const candidates = currencyCandidates(text);
  const numeric = text.match(/\d[\d.,'’   ]*\d|\d/);
  if (!numeric) return { amountMinor: null, currencyCandidates: candidates, error: 'no digits' };
  const raw = numeric[0].replace(/[\s  ]+$/u, '');
  const exp = minorExponent(expectedCurrency);
  const sepRe = /[.,'’   ]/gu;
  const seps = [...raw.matchAll(sepRe)];
  let intPart = raw;
  let fracPart = '';
  if (seps.length > 0 && exp > 0) {
    const last = seps[seps.length - 1];
    const after = raw.slice((last.index ?? 0) + 1);
    const isDecimalChar = last[0] === '.' || last[0] === ',';
    const sameAsEarlier = seps.slice(0, -1).some((s) => s[0] === last[0]);
    if (isDecimalChar && after.length === exp && !sameAsEarlier) {
      if (exp === 3 && seps.length === 1) {
        return { amountMinor: null, currencyCandidates: candidates, error: `ambiguous separator in "${raw}" for 3-decimal currency` };
      }
      intPart = raw.slice(0, last.index);
      fracPart = after;
    }
  }
  const intDigits = intPart.replace(sepRe, '');
  if (!/^\d+$/.test(intDigits)) return { amountMinor: null, currencyCandidates: candidates, error: `unparseable "${raw}"` };
  // Grouping sanity: every group after the first must be exactly 3 digits (Indian lakh grouping is not supported in v1).
  const groups = intPart.split(sepRe);
  if (groups.length > 1 && groups.slice(1).some((g) => g.length !== 3)) {
    return { amountMinor: null, currencyCandidates: candidates, error: `irregular digit grouping in "${raw}"` };
  }
  const frac = (fracPart + '0'.repeat(exp)).slice(0, exp);
  const amountMinor = Number(intDigits) * 10 ** exp + (exp > 0 ? Number(frac) : 0);
  return { amountMinor, currencyCandidates: candidates };
}
