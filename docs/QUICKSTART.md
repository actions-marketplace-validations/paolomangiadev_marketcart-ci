# Quickstart

## 1. Local demo (free, no key)

```bash
npm ci
npx playwright-core install chromium-headless-shell
node integrations/cli/marketcart.ts demo
```

Expected: C01 `PASS`, C05 `REGRESSION` (stored item, stale drawer), C16 `REGRESSION` (candidate theme broke the drawer). Exit status 0 means the demo behaved as expected.

## 2. Your own store (hosted)

1. Get a license key: EUR 19 for 100 hosted cases, valid 30 days from first use (https://payhip.com/buy?s=1&cart_links%5B%5D=er1iY&qty%5Ber1iY%5D=1). One free case per store is available on https://marketcart-ci.pages.dev/?src=github-docs while the free budget lasts.
2. `MARKETCART_LICENSE=<key> node integrations/cli/marketcart.ts token your-store.com`
   and paste the printed `<meta name="marketcart-verification" …>` tag into the `<head>` of `layout/theme.liquid`.
3. Copy `docs/cases.example.json`, put your product URLs and numeric variant IDs in it. Use the market URL the shopper would use (for example `/en-ie/`); the check verifies country and currency inside the session and refuses to guess.
4. `node integrations/cli/marketcart.ts remote cases.json` (password-protected development store: also set `MARKETCART_STOREFRONT_PASSWORD`).

Each single case uses 1 credit; a live/candidate pair uses 2. Only completed `PASS` / `REGRESSION` results use credits.

## 3. In CI

See `github-workflow.example.yml`. Store the key as the repository secret `MARKETCART_LICENSE`.
