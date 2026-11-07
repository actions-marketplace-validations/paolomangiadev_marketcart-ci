// Explicit Dawn-family adapter (Shopify's reference theme and the free themes built on it).
// Selectors follow Dawn's markup: <product-form>, input[name=id], .quantity__input, <cart-drawer>, #cart-icon-bubble.
// No arbitrary-theme support: anything else is UNSUPPORTED.

export const DAWN_FAMILY = new Set([
  'dawn', 'refresh', 'sense', 'craft', 'studio', 'taste', 'origin', 'crave', 'ride', 'colorblock', 'publisher', 'spotlight', 'trade',
]);

export const dawnAdapter = {
  name: 'dawn',
  declaresBadge: true,
  // Shopify Ajax amounts are scaled by 100 for every currency (see money.ts ASSUMPTION).
  storedAmountScale: 'shopify-cents' as const,
  selectors: {
    productForm: 'product-form form[action$="/cart/add"], form[action$="/cart/add"][data-type="add-to-cart-form"]',
    variantInput: 'product-form input[name="id"]',
    quantityInput: 'input.quantity__input[name="quantity"]',
    addButton: 'product-form button[name="add"]',
    drawer: 'cart-drawer',
    cartIcon: '#cart-icon-bubble',
  },
};

export interface PageContext {
  country: string | null;
  currency: string | null;
  themeSchema: string | null;
  themeVersion: string | null;
  hasProductForm: boolean;
  challenge: boolean;
  title: string;
  routesRoot: string;
}

// Runs inside the page. Must be self-contained.
export function readPageContext(): PageContext {
  const w = window as unknown as { Shopify?: { country?: string; currency?: { active?: string }; theme?: { schema_name?: string; schema_version?: string }; routes?: { root?: string } } };
  const title = document.title || '';
  const body = (document.body?.innerText || '').slice(0, 2000).toLowerCase();
  const challenge =
    /just a moment|attention required|verify you are human|checking your browser/i.test(title) ||
    !!document.querySelector('#challenge-form, #challenge-running, iframe[src*="challenges.cloudflare.com"], [data-hcaptcha-widget-id], .g-recaptcha') ||
    body.includes('verify you are human');
  return {
    country: w.Shopify?.country ?? null,
    currency: w.Shopify?.currency?.active ?? null,
    themeSchema: w.Shopify?.theme?.schema_name ?? null,
    themeVersion: w.Shopify?.theme?.schema_version ?? null,
    hasProductForm: !!document.querySelector('product-form form, form[action$="/cart/add"]'),
    challenge,
    title,
    routesRoot: w.Shopify?.routes?.root || '/',
  };
}

export interface RawVisible {
  surface: 'drawer' | 'cart-page';
  drawerOpen: boolean;
  lines: { href: string | null; title: string; options: string[]; quantity: string | null; priceText: string | null }[];
  badgeText: string | null;
  totalText: string | null;
}

// Runs inside the page. Reads the rendered drawer (or the cart page) only from visible DOM.
export function readVisibleCart(surface: 'drawer' | 'cart-page'): RawVisible {
  const txt = (el: Element | null | undefined) => (el ? (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : null);
  const isShown = (el: Element) => {
    const r = (el as HTMLElement).getClientRects();
    const cs = getComputedStyle(el as HTMLElement);
    return r.length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const root = surface === 'drawer' ? document.querySelector('cart-drawer') : document.querySelector('cart-items, #main-cart-items, main');
  const drawerOpen = surface === 'drawer' ? !!root && (root.classList.contains('active') || root.hasAttribute('open')) : true;
  const rows = root ? Array.from(root.querySelectorAll('.cart-item')).filter(isShown) : [];
  const lines = rows.map((row) => {
    const link = row.querySelector('a.cart-item__name') as HTMLAnchorElement | null;
    const qty = row.querySelector('input.quantity__input') as HTMLInputElement | null;
    const price = row.querySelector('.cart-item__totals .price, .cart-item__price-wrapper .price, .cart-item__final-price');
    return {
      href: link ? link.getAttribute('href') : null,
      title: txt(link) ?? txt(row.querySelector('.cart-item__name')) ?? '',
      options: Array.from(row.querySelectorAll('.product-option dd')).map((d) => txt(d) ?? ''),
      quantity: qty ? qty.value : null,
      priceText: txt(price),
    };
  });
  const bubble = document.querySelector('#cart-icon-bubble .cart-count-bubble');
  const badgeText = bubble ? txt(bubble.querySelector('span[aria-hidden="true"]')) ?? txt(bubble) : null;
  const totalEl = root ? root.querySelector('.totals__total-value') : null;
  return { surface, drawerOpen, lines, badgeText, totalText: totalEl && isShown(totalEl) ? txt(totalEl) : null };
}

export interface RawStoredCart {
  ok: boolean;
  status: number;
  body: {
    currency?: string;
    item_count?: number;
    total_price?: number;
    items?: { variant_id: number; product_title: string; variant_title: string | null; quantity: number; final_line_price: number }[];
  } | null;
}

// Runs inside the page: the stored cart via Shopify's Ajax API, independent of the DOM. Path is relative to the shop root.
export async function readStoredCart(): Promise<RawStoredCart> {
  const w = window as unknown as { Shopify?: { routes?: { root?: string } } };
  const root = w.Shopify?.routes?.root || '/';
  const r = await fetch(root + 'cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { ok: r.ok, status: r.status, body };
}
