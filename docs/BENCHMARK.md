# Benchmark: 20 synthetic cases (expected vs actual)

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
