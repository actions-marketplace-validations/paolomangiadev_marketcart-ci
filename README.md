# MarketCart CI

A release check for Shopify stores on **Dawn-family themes**. It adds an item in a real browser, then compares the cart Shopify **stored** (`/cart.js`) with what the shopper **sees** (drawer lines, variant, quantity, line price, currency, header badge, total). It prints a table, writes JSON and exits non-zero, so a theme deploy can fail before shoppers find the bug.

It exists for one class of bug: the store looks fine and the request succeeded, but the cart on screen is wrong. Examples the benchmark plants on purpose:

- the item is stored but the drawer still says "Your cart is empty";
- the header badge stays at 0;
- the drawer shows quantity 1 for a stored 2, or the requested 3 while the store kept 2;
- the shopper picked Blue but the theme added Red;
- the right number with the wrong currency sign, or a wrong amount;
- a theme preview (candidate) behaves differently from the live theme.

## 60-second quickstart (no key, no account)

With npx (Node.js 22.18+ and Git). npx still downloads and runs the package from GitHub, it just skips the manual clone; nothing is installed globally and nothing runs at install time:

```bash
npx github:paolomangiadev/marketcart-ci#v0.2.1 setup-browser   # once: headless Chromium for local runs (~100 MB)
npx github:paolomangiadev/marketcart-ci#v0.2.1 demo            # 3 seeded cases on a local synthetic store
```

Without arguments it prints help and does nothing billable. `setup-browser --with-deps` also installs the Linux system libraries (CI runners). Pin by tag (`#v0.2.1`) or an abbreviated commit SHA: a full 40-character SHA fails on npm 10 (Node 22's bundled npm) with "GitFetcher requires an Arborist constructor". `#v0.2.1` pins the command-line wrapper release; the check engine inside it is unchanged since v0.2.0. A downloadable tarball with its SHA-256 is attached to the [v0.2.1 release](https://github.com/paolomangiadev/marketcart-ci/releases/tag/v0.2.1) (`npm install ./marketcart-ci-0.2.1.tgz`).

From a clone (Node.js 22.18+ runs the TypeScript sources directly):

```bash
git clone https://github.com/paolomangiadev/marketcart-ci && cd marketcart-ci
npm ci
npx playwright-core install chromium-headless-shell
node integrations/cli/marketcart.ts demo     # 3 seeded cases on a local synthetic store
node integrations/cli/marketcart.ts bench    # the full 20-case benchmark
```

The demo store is a **synthetic fixture** (`fixtures/storefront/`): Dawn-style markup and Shopify-style Ajax endpoints with one known defect per scenario. A public copy runs at <https://marketcart-fixture.pages.dev/>. Passing the fixture proves the checks work on the fixture; it does not prove compatibility with a particular live store.

## Results and exit status

| Status | Meaning | Billed (hosted) |
|---|---|---|
| `PASS` | stored == visible on every check, market verified in-session | yes |
| `REGRESSION` | a real divergence: missing line, wrong variant, quantity, amount, currency, badge, total, or candidate differs from live | yes |
| `BLOCKED` | rate limit or bot challenge; never evaded | no |
| `UNSUPPORTED` | not a Dawn-family theme, market not verifiable, unreadable price | no |
| `ERROR` | timeout or engine failure (one bounded retry) | no |

Exit status: `0` all PASS · `1` at least one REGRESSION · `2` inconclusive only · `3` API/license error · `64` usage error.

A navigation success or HTTP 200 is never enough for PASS. No currency conversion is ever applied: the visible amount must equal the stored amount in the currency the store actually served in this session.

## GitHub Action

```yaml
- uses: paolomangiadev/marketcart-ci@v0
  with:
    mode: demo        # seeded synthetic demo, no secrets
```

Hosted run of your own store:

```yaml
- uses: actions/checkout@v4
- uses: paolomangiadev/marketcart-ci@v0
  with:
    mode: remote
    cases: marketcart/cases.json
    license: ${{ secrets.MARKETCART_LICENSE }}
```

Hosted checks of your own store (`mode: remote`) send your cases to the hosted service, which runs them in its own browser account and returns the same JSON. See `docs/QUICKSTART.md` and `docs/github-workflow.example.yml`. Fork pull requests never receive secrets, and the Action skips hosted mode when no license is present.

## Safety boundaries

- Only domains you prove you control (a one-line `<meta name="marketcart-verification">` tag) are checked by the hosted service.
- Never opens checkout, never submits payment, never logs in, never edits store settings, no anti-bot evasion.
- Private, loopback and link-local addresses are refused, including after redirects (DNS-resolved); checkout, account and payment paths are blocked at the browser level.
- 90-second per-case limit, concurrency 1, at most one retry. Screenshots of non-PASS cases mask inputs.

## Known limits

- Explicit adapters (`engine/adapters/themes.ts`): Dawn and the free themes built on it, and Horizon 4.4.0. Everything else returns `UNSUPPORTED`.
- Verification status: Dawn 16.1.1 cart page verified on a live development store; Dawn 15.4.1/16.1.1 drawer and Horizon 4.4.0 drawer/page verified on version-pinned synthetic markup (`fixtures/storefront/skins.ts`, 63-case matrix `scripts/theme-matrix.ts`), live verification pending.
- A theme with a cart drawer is tested on the drawer; a closed or stale drawer is never replaced by the cart page.
- Drawer cart surface first; cart page as fallback (Dawn's default "notification" cart type is checked on the cart page). Notification popups are not read.
- Shopify rate-limits rapid cart traffic (HTTP 429 seen on a development store after about four cases in under a minute). The CLI and the hosted runner pace each store (`engine/pacing.ts`: 15 s between cart cycles, Retry-After, capped exponential backoff with jitter, at most one retry in a fresh session). A case that stays throttled returns `BLOCKED` and is not billed.
- Zero-decimal currencies (JPY, KRW…) assume Shopify's Ajax "×100 for every currency" convention; confirm on your store.
- Indian lakh digit grouping is not parsed (returns `UNSUPPORTED`, never PASS).

## Layout

```
engine/            assertions (pure), money parsing, safety policy, Dawn adapter, Playwright runner, CLI
                   (+ cli.bundle.js / run.js: generated JavaScript build of the same sources for the package)
bin/               generated package entry (bundle of integrations/cli/marketcart.ts)
fixtures/storefront synthetic Dawn-like store with 15 scenarios (Node server + Workers entry)
evidence/          the 20-case benchmark contract and a recorded run
integrations/cli   public wrapper: setup-browser, demo, bench, check, remote, token
scripts/           build-package.ts (regenerates bin/ and engine/*.js), theme-matrix.ts
web/               static checker page
```

## Hosted checks and pricing

Workflow generator (copy-paste GitHub Actions YAML): https://marketcart-ci.pages.dev/tools/github-action-generator/?src=github-readme · Guides: https://marketcart-ci.pages.dev/guides/shopify-dawn-cart-drawer-not-updating/?src=github-readme · https://marketcart-ci.pages.dev/guides/shopify-cart-js-422-429-test/?src=github-readme · https://marketcart-ci.pages.dev/guides/shopify-markets-currency-mismatch-cart-total-test/?src=github-readme · https://marketcart-ci.pages.dev/guides/shopify-ajax-cart-drawer-web-components-playwright/?src=github-readme · https://marketcart-ci.pages.dev/guides/shopify-theme-check-vs-playwright-cart-e2e/?src=github-readme · https://marketcart-ci.pages.dev/guides/github-actions-shopify-preview-theme-e2e/?src=github-readme

Standalone snippets (Gists): [cart drawer test workflow, Dawn + Horizon](https://gist.github.com/paolomangiadev/8df461ab021b181bd49a1ad626524f3a) · [Markets currency parity check, TypeScript](https://gist.github.com/paolomangiadev/666b9a370c2ad345370ddb3d79b28c8e)
Checker, live demo and one free case per store: https://marketcart-ci.pages.dev/?src=github-readme · machine-readable docs: https://marketcart-ci.pages.dev/llms.txt?src=github-readme

**EUR 19 = 100 completed hosted cases**, valid 30 days from activation (https://payhip.com/b/er1iY). Only `PASS`/`REGRESSION` use credits. A live/candidate pair uses 2. No subscription. The license key is delivered automatically by Payhip and verified on every job; refunds disable it. The hosted service runs the same engine in Cloudflare Browser Run with a D1 credit ledger (`service/`).

## Benchmark (synthetic, expected vs actual)

Run `bench-20261107T161307Z` · engine `0.1.0+0a4e5cee` · **20/20** classified as expected · planted regressions caught **10/10** · false PASS **0**.

Method: the 20 cases and their expected statuses were frozen in `evidence/benchmark-manifest.json` before the engine was written. Each case runs against a **synthetic fixture** (a mock store with Dawn-style markup, https://marketcart-fixture.pages.dev) where one scenario plants one known defect. The fixture and the engine have the same author, so this table shows the classes of bugs the engine detects; it does not prove behaviour on any particular live store. Live smoke results on a real Shopify development store are reported separately.

| Case | Group | What is planted | Expected | Actual | Engine reason |
|---|---|---|---|---|---|
| C01 | healthy-baseline | Single default variant, qty 1, EUR market verified; stored == visible drawer/badge/total. | PASS | PASS | stored == visible across 1 line(s), market IE/EUR verified in-session |
| C02 | healthy-baseline | Non-default variant selected via ?variant; stored and visible both Blue / M. | PASS | PASS | stored == visible across 1 line(s), market IE/EUR verified in-session |
| C03 | healthy-baseline | Quantity 3; stored qty, visible qty, badge 3 and line total agree. | PASS | PASS | stored == visible across 1 line(s), market IE/EUR verified in-session |
| C04 | healthy-baseline | Zero-decimal currency: JPY minor units are whole yen; ¥7,800 must equal stored 7800 without a /100 conversion. | PASS | PASS | stored == visible across 1 line(s), market JP/JPY verified in-session |
| C05 | stale-visible-state | Item stored in cart but the drawer keeps its stale empty render. | REGRESSION | REGRESSION | stored 1 line(s), visible 0 line(s) in drawer; stored line Linen Shirt (Red / M, variant 4101) not visible |
| C06 | stale-visible-state | Drawer correct, header cart badge not updated (adapter declares badge; fixture expects it). | REGRESSION | REGRESSION | stored item_count 1, badge absent |
| C07 | stale-visible-state | Stored qty 2, drawer shows stale qty 1. | REGRESSION | REGRESSION | variant 4101: stored qty 2, visible qty 1 |
| C08 | item-quantity-drift | Shopper selected Blue / M (4102); theme JS posts the default variant 4101. | REGRESSION | REGRESSION | requested variant 4102 not in stored cart (stored: 4101); unexpected stored variant 4101 |
| C09 | item-quantity-drift | Two items stored; drawer re-render drops the second line. | REGRESSION | REGRESSION | stored 2 line(s), visible 1 line(s) in drawer; stored line Merino Socks (Default Title, variant 6301) not visible |
| C10 | item-quantity-drift | Server persists qty 2 (clamp) while the optimistic UI shows the requested 3. | REGRESSION | REGRESSION | variant 4101: requested qty 3, stored qty 2; variant 4101: stored qty 2, visible qty 3; variant 4101: stored line 4800 EUR minor, visible 7200 |
| C11 | currency-price | Market IE/EUR verified in-session, but the stored cart currency is USD (wrong currency). | REGRESSION | REGRESSION | stored cart currency USD, verified market currency EUR; variant 4101: visible "$26.00" indicates USD/CAD/AUD/NZD/MXN/SGD/HKD/CLP/COP/ARS, market EUR; visible total "$26.00" indicates USD/CAD/AUD/NZD/M |
| C12 | currency-price | Stored EUR 24.00; drawer shows the same number with the wrong currency ($24.00). | REGRESSION | REGRESSION | variant 4101: visible "$24.00" indicates USD/CAD/AUD/NZD/MXN/SGD/HKD/CLP/COP/ARS, market EUR; visible total "$24.00" indicates USD/CAD/AUD/NZD/MXN/SGD/HKD/CLP/COP/ARS, market EUR |
| C13 | currency-price | Stored EUR 24.00; drawer shows a wrong amount (€20.00). | REGRESSION | REGRESSION | variant 4101: stored line 2400 EUR minor, visible 2000 |
| C14 | currency-price | Equivalent localized formatting: de-DE '1.234,56 €' equals stored 123456 EUR minor units (dot = grouping, comma = decimal). | PASS | PASS | stored == visible across 1 line(s), market DE/EUR verified in-session |
| C15 | live-candidate | Healthy live vs unchanged healthy candidate: both pass, observations identical. Consumes 2 cases. | PASS | PASS | live and candidate both pass with identical stored/visible observations |
| C16 | live-candidate | Healthy live vs broken candidate (stale drawer). Consumes 2 cases. | REGRESSION | REGRESSION | candidate regressed (live PASS) |
| C17 | inconclusive | Storefront answers 429 with a bot-challenge interstitial; never PASS. | BLOCKED | BLOCKED | storefront rate limited (HTTP 429) |
| C18 | inconclusive | Non-Dawn theme markup: no supported adapter; never PASS. | UNSUPPORTED | UNSUPPORTED | no supported adapter: theme schema "Debut" |
| C19 | inconclusive | Add-to-cart request hangs; per-case timeout fires (6 s fixture timeout, one bounded retry); never PASS. | ERROR | ERROR | case timeout after 6000 ms |
| C20 | inconclusive | Requested JP/JPY but the store keeps serving IE/EUR in-session; the market cannot be verified, even though the cart itself is internally consistent; never PASS. | UNSUPPORTED | UNSUPPORTED | requested market JP/JPY not verified in-session (observed IE/EUR) |

Reproduce: `npm ci && npx playwright-core install chromium-headless-shell && node engine/cli.ts bench`.


## Competitor matrix (scoped)

Read 2026-11-07. "EXECUTED" means we ran the product on the same synthetic inputs; "DOCUMENTED" means only the vendor listing was read. Two executed synthetic cases do not support a broad superiority claim.

| Product | What it checks | Result on our fixture | Price | Evidence |
|---|---|---|---|---|
| MarketCart CI (this project) | Real browser; theme add-to-cart; /cart.js read independently of the DOM; drawer/cart page, badge, total, in-session market currency | C05 stale drawer: REGRESSION · C08 wrong variant: REGRESSION (20/20 synthetic cases as expected) | EUR 19 / 100 completed hosted cases (30 days); CLI free locally | EXECUTED (synthetic fixture + Founder-owned live Dawn dev store) ([source](https://github.com/paolomangiadev/marketcart-ci)) |
| E-Com Checkout Auditor (Apify Actor) | Browser journey product → cart → checkout page, pass/fail per phase | C05 stale drawer: returned success (run nv2AeksMAjnh2ksTq) · C08 wrong variant: returned success (run bJKqMgPGZy7PxTBJq). Our parity contract expects REGRESSION for both. n = 2 synthetic cases | USD 0.05 per result (Apify Store, 2026-11-06) | EXECUTED n=2 on our synthetic fixture ([source](https://apify.com/solutionssmart/e-com-checkout-auditor)) |
| Shopify Variant Cartability Checker (Apify Actor) | Ajax cart API transaction path (/products/x.js, /cart/add.js); never reads the rendered drawer by design | Inconclusive: our path-prefixed fixture is incompatible with root-relative tools (runs bs9d3gdsxiMNjjmig, fv8KT7HOpo32sX8cB) | USD 0.005 per result (2026-11-06) | EXECUTED, inconclusive (fixture limitation) ([source](https://apify.com/silver-rook-labs/shopify-variant-cartability-checker)) |
| PromiseCheck: Cart Monitoring (Shopify app) | Add to Cart, options and cart quantities on desktop/mobile; draft-theme vs saved live scan; hourly checks; screenshots, alerts | Not tested (differently scoped Shopify Admin app; price anchor only) | USD 79.99 / month, 14-day trial (listing read 2026-11-07) | DOCUMENTED, UNTESTED ([source](https://apps.shopify.com/promisecheck)) |
| StoreCheck Markets (Shopify app) | Live cart checks per market: availability, currency, totals, quantities, discounts | Not tested | Free manual / USD 9.99 per month automated (listing read 2026-11-06) | DOCUMENTED, UNTESTED ([source](https://apps.shopify.com/storecheck-markets)) |

E-Com Checkout Auditor raw outputs (sanitized): both runs returned a `success` journey for our fixture URLs; on C05 the drawer stayed empty while /cart.js held the item, on C08 the stored variant differed from the requested one. PromiseCheck is a differently scoped Shopify Admin app (monitoring, screenshots, alerts) listed as a price anchor; it was not tested.


License: MIT.
