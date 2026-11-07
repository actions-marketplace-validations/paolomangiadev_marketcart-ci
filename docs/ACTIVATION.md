# MarketCart CI — 100-case pack: activation

Thank you for buying a MarketCart CI pack. Your **license key** is shown on the purchase page and in the Payhip receipt email. It is your API key: keep it secret (GitHub Actions secret, CI secret store), never put it in a URL or a committed file.

## What the pack contains

- **100 completed hosted cases**, valid **30 days from activation** (the first API call that uses the key).
- A case is completed when the result is **PASS** or **REGRESSION**. **ERROR / BLOCKED / UNSUPPORTED** results release the credit (not billed).
- A live/candidate **pair** (published theme vs an unpublished theme preview) uses **2 cases**.
- No subscription. No automatic renewal.

## Scope and limits (read before running)

- Shopify stores you own, running **Dawn** or a Dawn-family theme (Dawn, Refresh, Sense, Craft, Studio, Taste, Origin, Crave, Ride, Colorblock, Publisher, Spotlight, Trade). **Horizon and other themes return UNSUPPORTED** (credit released).
- Checks: requested variant and quantity vs the stored cart (`/cart.js`), stored vs visible cart (drawer or cart page), line prices, badge, total, and the **in-session market currency**. No currency conversion, ever.
- Never visits checkout, account or payment pages. Never places orders.
- Ownership proof is required per store: a meta tag in your theme `<head>` (step 2).
- Password-protected (development / pre-launch) stores: pass the storefront password in the request body; it is used in memory only and never stored or logged.
- Concurrency 1. Shopify rate-limits rapid cart traffic; a throttled case returns **BLOCKED** (released, not billed). Space large suites out.

## 1. Check the key

```bash
curl -H "Authorization: Bearer $MARKETCART_LICENSE" https://marketcart-ci.pages.dev/v1/balance
```

## 2. Prove you control the store

```bash
curl -H "Authorization: Bearer $MARKETCART_LICENSE" "https://marketcart-ci.pages.dev/v1/domain-token?host=your-store.myshopify.com"
```

Paste the returned `<meta name="marketcart-verification" ...>` tag into **Online Store → Themes → Edit code → layout/theme.liquid**, inside `<head>`.

## 3. Run cases

From the open-source CLI or GitHub Action (`marketcart remote cases.json`), or directly:

```bash
curl -X POST https://marketcart-ci.pages.dev/v1/jobs \
  -H "Authorization: Bearer $MARKETCART_LICENSE" -H "content-type: application/json" \
  -d @job.json
```

`job.json`: `{ "jobId": "release-2026-11-07", "authorizedDomains": ["your-store.myshopify.com"], "cases": [ { "id": "home-tee", "market": { "country": "US", "currency": "USD" }, "lines": [ { "url": "https://your-store.myshopify.com/products/tee?variant=123", "variantId": 123, "quantity": 1 } ] } ] }`

Re-sending the same `jobId` returns the stored result and is never billed twice. `GET /v1/jobs/<jobId>` (same header) returns it later.

## Refunds

Refunded purchases disable the license automatically; remaining credits stop working. Documentation, examples and known limitations: the public repository linked on the product page. There is no setup service or custom support bundled with the pack.
