import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorExponent, parseMoney, shopifyCentsToIsoMinor } from '../engine/money.ts';
import { allowRequest, assertCaseUrl, findSecrets, isPrivateAddress, sanitizeUrl } from '../engine/safety.ts';

test('localized money parsing respects the currency exponent and never converts', () => {
  const cases: [string, string, number | null][] = [
    ['€24.00', 'EUR', 2400],
    ['24,00 €', 'EUR', 2400],
    ['1.234,56 €', 'EUR', 123456],
    ['€1,234.56', 'EUR', 123456],
    ['CHF 1’234.50', 'CHF', 123450],
    ['¥7,800', 'JPY', 7800],
    ['￥7,800', 'JPY', 7800],
    ['€1.234', 'EUR', 123400],
    ['$26.00', 'USD', 2600],
    ['€24.5', 'EUR', null],
    ['', 'EUR', null],
  ];
  for (const [text, cur, want] of cases) assert.equal(parseMoney(text, cur).amountMinor, want, text);
  assert.deepEqual(parseMoney('$24.00', 'EUR').currencyCandidates.includes('EUR'), false);
  assert.deepEqual(parseMoney('US$24.00', 'USD').currencyCandidates, ['USD']);
  assert.equal(parseMoney('24.00', 'EUR').currencyCandidates.length, 0);
  assert.equal(minorExponent('KWD'), 3);
  assert.equal(parseMoney('1.234', 'KWD').amountMinor, null); // ambiguous for a 3-decimal currency
});

test('Shopify cents-like amounts normalize to ISO minor units', () => {
  assert.equal(shopifyCentsToIsoMinor(2400, 'EUR'), 2400);
  assert.equal(shopifyCentsToIsoMinor(780000, 'JPY'), 7800);
});

test('SSRF: private, loopback, link-local and metadata ranges are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['23.227.38.65', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  const policy = { authorizedDomains: ['shop.example.com'], allowLoopbackFixture: false };
  await assert.rejects(assertCaseUrl('http://shop.example.com/products/x', policy), /https/);
  await assert.rejects(assertCaseUrl('https://other.example.net/products/x', policy), /not an owner-authorized/);
  await assert.rejects(assertCaseUrl('https://user:pw@shop.example.com/', policy), /credentials/);
  await assert.rejects(assertCaseUrl('http://127.0.0.1:8080/products/x', policy), /loopback/);
  await assert.rejects(assertCaseUrl('https://169.254.169.254/latest/meta-data', { authorizedDomains: ['169.254.169.254'], allowLoopbackFixture: false }), /private/);
  assert.equal((await allowRequest('https://shop.example.com/checkouts/abc', true, policy)).ok, false);
  assert.equal((await allowRequest('https://evil.example.org/', true, policy)).ok, false); // redirect off the authorized host
  assert.equal((await allowRequest('http://10.0.0.5/x.png', false, policy)).ok, false);
  assert.equal((await allowRequest('file:///etc/passwd', false, policy)).ok, false);
});

test('sanitized URLs keep only reproduction parameters; secrets are detected', () => {
  assert.equal(sanitizeUrl('https://a:b@shop.example.com/products/x?variant=1&_pos=2&token=abc#frag'), 'https://shop.example.com/products/x?variant=1');
  assert.deepEqual(findSecrets('license AAAAA-BBBBB-CCCCC-DDDDD').length, 1);
  assert.deepEqual(findSecrets('{"status":"PASS"}'), []);
});
