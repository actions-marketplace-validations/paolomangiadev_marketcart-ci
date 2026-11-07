// Explicit theme adapters. Each one names the markup it reads; anything unlisted is UNSUPPORTED.
//   dawn:    Shopify Dawn and the free themes built on it (selectors checked against Dawn v15.4.1 and v16.1.1 source).
//   horizon: Shopify Horizon (selectors checked against Shopify/horizon v4.4.0 source: theme-drawer#cart-drawer >
//            dialog, cart-items__table-row, cart-bubble__text-count, cart-totals__total-value, add-to-cart-component).
// Horizon-family siblings are NOT whitelisted until their markup is checked.
import { DAWN_FAMILY } from './dawn.ts';

export type AdapterName = 'dawn' | 'horizon';

export const HORIZON_FAMILY = new Set(['horizon']);

export function adapterForSchema(schema: string | null): AdapterName | null {
  const s = (schema ?? '').toLowerCase();
  if (DAWN_FAMILY.has(s)) return 'dawn';
  if (HORIZON_FAMILY.has(s)) return 'horizon';
  return null;
}

export interface AdapterSelectors {
  variantInput: string;
  quantityInput: string;
  addButton: string;
  drawer: string; // element that exists only when the theme uses a cart drawer
  drawerTrigger: string; // header control that opens the drawer
}

export const ADAPTERS: Record<AdapterName, { declaresBadge: boolean; selectors: AdapterSelectors }> = {
  dawn: {
    declaresBadge: true,
    selectors: {
      variantInput: 'product-form input[name="id"]',
      quantityInput: 'input.quantity__input[name="quantity"]',
      addButton: 'product-form button[name="add"]',
      drawer: 'cart-drawer',
      drawerTrigger: '#cart-icon-bubble',
    },
  },
  horizon: {
    declaresBadge: true,
    selectors: {
      variantInput: 'product-form-component input[name="id"]',
      quantityInput: 'input[name="quantity"]:not([name="updates[]"])',
      addButton: 'add-to-cart-component button[name="add"], product-form-component button[name="add"]',
      drawer: 'theme-drawer#cart-drawer dialog',
      drawerTrigger: 'button[aria-controls="cart-drawer"], [data-testid="cart-drawer-trigger"]',
    },
  },
};

// Runs inside the page. Self-contained (no closures).
export function drawerIsOpen(adapter: AdapterName): boolean {
  if (adapter === 'dawn') {
    const d = document.querySelector('cart-drawer');
    return !!d && (d.classList.contains('active') || d.hasAttribute('open'));
  }
  const dlg = document.querySelector('theme-drawer#cart-drawer dialog') as HTMLDialogElement | null;
  const host = document.querySelector('theme-drawer#cart-drawer');
  return !!dlg && (dlg.open || dlg.hasAttribute('open') || !!host?.hasAttribute('open'));
}

export interface RawVisibleAny {
  surface: 'drawer' | 'cart-page';
  adapter: AdapterName;
  drawerOpen: boolean;
  lines: { href: string | null; title: string; options: string[]; quantity: string | null; priceText: string | null }[];
  badgeText: string | null;
  totalText: string | null;
}

// Runs inside the page: reads only the rendered surface (drawer or cart page) for the given adapter.
export function readVisibleCartAny(arg: { surface: 'drawer' | 'cart-page'; adapter: AdapterName }): RawVisibleAny {
  const { surface, adapter } = arg;
  const txt = (el: Element | null | undefined) => (el ? (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : null);
  const shown = (el: Element) => {
    const r = (el as HTMLElement).getClientRects();
    const cs = getComputedStyle(el as HTMLElement);
    return r.length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  if (adapter === 'dawn') {
    const root = surface === 'drawer' ? document.querySelector('cart-drawer') : document.querySelector('cart-items, #main-cart-items, main');
    const drawerOpen = surface === 'drawer' ? !!root && (root.classList.contains('active') || root.hasAttribute('open')) : true;
    const rows = root ? Array.from(root.querySelectorAll('.cart-item')).filter(shown) : [];
    const lines = rows.map((row) => {
      const link = row.querySelector('a.cart-item__name') as HTMLAnchorElement | null;
      const qty = row.querySelector('input.quantity__input') as HTMLInputElement | null;
      const price = row.querySelector('.cart-item__totals .price, .cart-item__price-wrapper .price, .cart-item__final-price');
      return { href: link ? link.getAttribute('href') : null, title: txt(link) ?? txt(row.querySelector('.cart-item__name')) ?? '', options: Array.from(row.querySelectorAll('.product-option dd')).map((d) => txt(d) ?? ''), quantity: qty ? qty.value : null, priceText: txt(price) };
    });
    const bubble = document.querySelector('#cart-icon-bubble .cart-count-bubble');
    const badgeText = bubble ? txt(bubble.querySelector('span[aria-hidden="true"]')) ?? txt(bubble) : null;
    const totalEl = root ? root.querySelector('.totals__total-value') : null;
    return { surface, adapter, drawerOpen, lines, badgeText, totalText: totalEl && shown(totalEl) ? txt(totalEl) : null };
  }
  // Horizon
  const drawerHost = document.querySelector('theme-drawer#cart-drawer');
  const dlg = drawerHost ? (drawerHost.querySelector('dialog') as HTMLDialogElement | null) : null;
  const root = surface === 'drawer' ? dlg : document.querySelector('main cart-items-component, main .cart-items__table, main');
  const drawerOpen = surface === 'drawer' ? !!dlg && (dlg.open || dlg.hasAttribute('open') || !!drawerHost?.hasAttribute('open')) : true;
  const rows = root ? Array.from(root.querySelectorAll('tr.cart-items__table-row:not(.cart-items__nested-line)')).filter((r) => !(r as HTMLElement).closest('template')) : [];
  const lines = rows.map((row) => {
    const link = row.querySelector('a.cart-items__title') as HTMLAnchorElement | null;
    const qty = row.querySelector('input[name="updates[]"], input[name="quantity"]') as HTMLInputElement | null;
    const price = row.querySelector('td.cart-items__price bdi, td.cart-items__price text-component, td.cart-items__price');
    const options = Array.from(row.querySelectorAll('dl.cart-items__variants dd')).map((d) => (txt(d) ?? '').replace(/[, \s]+$/u, '').trim());
    return { href: link ? link.getAttribute('href') : null, title: txt(link) ?? '', options, quantity: qty ? qty.value : null, priceText: txt(price) };
  });
  const bubble = document.querySelector('.cart-bubble__text-count, [data-testid="cart-bubble"]');
  const bubbleWrap = bubble ? bubble.closest('.cart-bubble') : null;
  const bubbleHidden = !bubble || bubble.classList.contains('hidden') || !!bubbleWrap?.classList.contains('visually-hidden');
  const badgeText = bubbleHidden ? null : txt(bubble);
  const totalEl = root ? root.querySelector('.cart-totals__total-value, [data-testid="cart-total-value"]') : null;
  return { surface, adapter, drawerOpen, lines, badgeText: badgeText === '' ? null : badgeText, totalText: totalEl && shown(totalEl) ? txt(totalEl) : null };
}
