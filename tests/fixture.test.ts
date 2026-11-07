import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_MONEY_CLIENT_JS, formatMoney } from '../fixtures/storefront/app.ts';

test('fixture client and server money formatters agree', () => {
  const client = new Function(`return (${FORMAT_MONEY_CLIENT_JS});`)() as (c: number, f: string) => string;
  const formats = ['€{{amount}}', '{{amount_with_comma_separator}} €', '¥{{amount_no_decimals}}', '${{amount}}'];
  for (const cents of [0, 900, 2400, 123456, 780000, 20000000, 99999999]) {
    for (const f of formats) assert.equal(client(cents, f), formatMoney(cents, f), `${cents} ${f}`);
  }
  assert.equal(formatMoney(123456, '{{amount_with_comma_separator}} €'), '1.234,56 €');
  assert.equal(formatMoney(780000, '¥{{amount_no_decimals}}'), '¥7,800');
});
