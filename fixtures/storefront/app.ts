// Owned deterministic mock storefront with Dawn-family markup and Shopify-style Ajax cart endpoints.
// SYNTHETIC FIXTURE: it imitates the public shape of Dawn + /cart.js; it is not Shopify and proves nothing about live stores.
// Scenarios plant one known defect each; the engine only ever sees URLs and the rendered page.
// Fetch-handler style (Request -> Response) so it runs under Node and could run on any fetch-compatible host.

export const SCENARIOS = [
  'healthy', 'healthy-candidate', 'stale-drawer', 'stale-badge', 'stale-qty', 'wrong-variant', 'drop-second', 'qty-clamp',
  'cart-currency-usd', 'visible-wrong-symbol', 'visible-wrong-amount', 'challenge', 'non-dawn', 'hang', 'no-market',
  'password-gate',
] as const;

// Storefront password gate (Shopify-style: form at /password, digest cookie on success). Test-only constant password.
export const FIXTURE_STOREFRONT_PASSWORD = 'fixture-pass';
const DIGEST = 'fixture-digest-ok';
export type Scenario = (typeof SCENARIOS)[number];

interface Variant { id: number; title: string; options: [string, string][]; prices: Record<string, number> }
interface Product { handle: string; title: string; variants: Variant[] }

// Prices use Shopify's Ajax convention: value * 100 for every currency (JPY 390000 = ¥3,900).
const CATALOG: Product[] = [
  { handle: 'linen-shirt', title: 'Linen Shirt', variants: [
    { id: 4101, title: 'Red / M', options: [['Color', 'Red'], ['Size', 'M']], prices: { EUR: 2400, USD: 2600, JPY: 390000 } },
    { id: 4102, title: 'Blue / M', options: [['Color', 'Blue'], ['Size', 'M']], prices: { EUR: 2400, USD: 2600, JPY: 390000 } },
  ] },
  { handle: 'socks', title: 'Merino Socks', variants: [{ id: 6301, title: 'Default Title', options: [], prices: { EUR: 900, USD: 1000, JPY: 150000 } }] },
  { handle: 'wool-coat', title: 'Wool Coat', variants: [{ id: 5201, title: 'Default Title', options: [], prices: { EUR: 123456, USD: 133000, JPY: 20000000 } }] },
];

const MARKETS: Record<string, { currency: string; format: string }> = {
  IE: { currency: 'EUR', format: '€{{amount}}' },
  DE: { currency: 'EUR', format: '{{amount_with_comma_separator}} €' },
  JP: { currency: 'JPY', format: '¥{{amount_no_decimals}}' },
  US: { currency: 'USD', format: '${{amount}}' },
};
const CURRENCY_FORMAT: Record<string, string> = { EUR: '€{{amount}}', USD: '${{amount}}', JPY: '¥{{amount_no_decimals}}' };

// Client copy of formatMoney as source text: bundlers rewrite Function.prototype.toString() output (wrangler's keepNames
// injected an undefined __name helper and broke the deployed drawer on 2026-11-06). Parity is unit-tested.
export const FORMAT_MONEY_CLIENT_JS = String.raw`function(cents, format){var group=function(n,sep){return n.replace(/\B(?=(\d{3})+(?!\d))/g,sep);};var fixed=(cents/100).toFixed(2);var p=fixed.split('.');var i=p[0],d=p[1];return format.replace('{{amount_with_comma_separator}}',group(i,'.')+','+d).replace('{{amount_no_decimals}}',group(String(Math.round(cents/100)),',')).replace('{{amount}}',group(i,',')+'.'+d);}`;

// Shopify-style money formatter (amount in cents), server side.
export function formatMoney(cents: number, format: string): string {
  const group = (n: string, sep: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const fixed = (cents / 100).toFixed(2);
  const [i, d] = fixed.split('.');
  return format
    .replace('{{amount_with_comma_separator}}', group(i, '.') + ',' + d)
    .replace('{{amount_no_decimals}}', group(String(Math.round(cents / 100)), ','))
    .replace('{{amount}}', group(i, ',') + '.' + d);
}

interface CartState { token: string; currency: string; items: { id: number; quantity: number }[] }

function b64(s: string): string { return btoa(unescape(encodeURIComponent(s))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64(s: string): string { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

function findVariant(id: number): { product: Product; variant: Variant } | null {
  for (const product of CATALOG) for (const variant of product.variants) if (variant.id === id) return { product, variant };
  return null;
}

function resolveMarket(req: Request, url: URL, sc: Scenario): string {
  if (sc === 'no-market') return 'IE';
  const q = url.searchParams.get('country')?.toUpperCase();
  if (q && MARKETS[q]) return q;
  const c = cookies(req).mkt;
  return c && MARKETS[c] ? c : 'IE';
}

function readCart(req: Request): CartState | null {
  const raw = cookies(req).cart;
  if (!raw) return null;
  try { return JSON.parse(unb64(raw)) as CartState; } catch { return null; }
}

function cartJson(state: CartState | null, sc: Scenario, root: string) {
  const currency = state?.currency ?? 'EUR';
  const items = (state?.items ?? []).map((it) => {
    const f = findVariant(it.id)!;
    const price = f.variant.prices[currency];
    return {
      id: it.id, variant_id: it.id, key: `${it.id}:fixture`, quantity: it.quantity, product_title: f.product.title, title: f.product.title + (f.variant.title === 'Default Title' ? '' : ' - ' + f.variant.title),
      variant_title: f.variant.title === 'Default Title' ? null : f.variant.title, options_with_values: f.variant.options.map(([name, value]) => ({ name, value })),
      price, original_price: price, line_price: price * it.quantity, final_price: price, final_line_price: price * it.quantity, url: `${root}products/${f.product.handle}?variant=${it.id}`,
    };
  });
  return { token: state?.token ?? 'fixture-empty', note: null, attributes: {}, currency, item_count: items.reduce((a, i) => a + i.quantity, 0), total_price: items.reduce((a, i) => a + i.final_line_price, 0), items_subtotal_price: items.reduce((a, i) => a + i.final_line_price, 0), requires_shipping: true, items };
}

function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!); }

function drawerRowsHtml(cart: ReturnType<typeof cartJson>, format: string): string {
  if (cart.items.length === 0) return '';
  return cart.items.map((it, n) => `<tr id="CartDrawer-Item-${n + 1}" class="cart-item">
  <td class="cart-item__details"><a href="${esc(it.url)}" class="cart-item__name h4 break">${esc(it.product_title)}</a>
    <dl>${it.options_with_values.map((o) => `<div class="product-option"><dt>${esc(o.name)}: </dt><dd>${esc(o.value)}</dd></div>`).join('')}</dl></td>
  <td class="cart-item__quantity"><quantity-popover><input class="quantity__input" type="number" name="updates[]" value="${it.quantity}" min="0" data-index="${n + 1}"></quantity-popover></td>
  <td class="cart-item__totals right"><div class="cart-item__price-wrapper"><span class="price price--end">${esc(formatMoney(it.final_line_price, format))}</span></div></td>
</tr>`).join('\n');
}

function bubbleHtml(count: number): string {
  return count > 0 ? `<div class="cart-count-bubble"><span aria-hidden="true">${count}</span><span class="visually-hidden">${count} items</span></div>` : '';
}

const STYLE = `body{font-family:system-ui,sans-serif;margin:0}header{display:flex;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #ddd}
#cart-icon-bubble{position:relative;display:inline-block;padding:4px 10px;border:1px solid #333;border-radius:4px;cursor:pointer}
.cart-count-bubble{display:inline-block;margin-left:6px;background:#111;color:#fff;border-radius:10px;padding:0 6px}
main{padding:20px}cart-drawer{position:fixed;top:0;right:0;width:420px;height:100%;background:#fff;border-left:1px solid #ccc;visibility:hidden;transform:translateX(100%)}
cart-drawer.active{visibility:visible;transform:none}.drawer__inner{padding:16px}.cart-items{width:100%;border-collapse:collapse}.cart-item td{border-bottom:1px solid #eee;padding:6px;vertical-align:top}
dl{margin:4px 0}.product-option{display:flex;gap:4px;font-size:13px}.quantity__input{width:48px}.fixture-banner{background:#fff3cd;padding:6px 20px;font-size:13px}`;

function shell(opts: { sc: Scenario; root: string; mkt: string; currency: string; schema: string; title: string; body: string; cart: ReturnType<typeof cartJson>; format: string }): string {
  const { sc, root, mkt, currency, schema, cart, format } = opts;
  const empty = cart.items.length === 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title)}</title><meta name="robots" content="noindex">
<style>${STYLE}</style>
<script>window.Shopify={shop:"fixture.myshopify.example",locale:"en",country:${JSON.stringify(mkt)},currency:{active:${JSON.stringify(currency)},rate:"1.0"},theme:{name:${JSON.stringify(schema)},schema_name:${JSON.stringify(schema)},role:"main"},routes:{root:${JSON.stringify(root)}}};</script>
</head><body>
<div class="fixture-banner">SYNTHETIC FIXTURE — scenario <code>${esc(sc)}</code>. Not a real store; nothing is for sale.</div>
<header><a href="${root}">Fixture Store</a>${schema === 'Dawn' ? `<a id="cart-icon-bubble" class="header__icon header__icon--cart" href="${root}cart">Cart${bubbleHtml(cart.item_count)}</a>` : `<a class="site-header__cart" href="${root}cart">Cart (${cart.item_count})</a>`}</header>
<main>${opts.body}</main>
${schema === 'Dawn' ? `<cart-drawer class="drawer${empty ? ' is-empty' : ''}"><div id="CartDrawer" class="cart-drawer"><div class="drawer__inner">
  <div class="drawer__header"><h2 class="drawer__heading">Your cart</h2></div>
  <div class="drawer__inner-empty"${empty ? '' : ' hidden'}><p class="cart__empty-text">Your cart is empty</p></div>
  <cart-drawer-items><table class="cart-items"><tbody id="CartDrawer-Items">${drawerRowsHtml(cart, format)}</tbody></table></cart-drawer-items>
  <div class="totals"${empty ? ' hidden' : ''}><h2 class="totals__total">Estimated total</h2><p class="totals__total-value">${esc(formatMoney(cart.total_price, format))}</p></div>
  <form action="${root}cart" method="post" id="CartDrawer-Form"><button type="submit" id="CartDrawer-Checkout" name="checkout" class="cart__checkout-button button">Check out</button></form>
</div></div></cart-drawer>` : ''}
</body></html>`;
}

function clientScript(sc: Scenario, root: string, format: string, variants: Variant[]): string {
  const bug = JSON.stringify(sc);
  const firstVariant = variants[0].id;
  const unitPrices = JSON.stringify(Object.fromEntries(variants.map((v) => [v.id, v.prices])));
  // Dawn-like product-form behaviour, plus exactly one planted defect per scenario.
  return `<script>
(function(){
  var BUG=${bug}, ROOT=${JSON.stringify(root)}, FORMAT=${JSON.stringify(format)}, FIRST=${firstVariant}, UNIT=${unitPrices};
  var formatMoney=${FORMAT_MONEY_CLIENT_JS};
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function render(cart, posted){
    var fmt = BUG==='visible-wrong-symbol' ? '\${{amount}}' : (BUG==='cart-currency-usd' ? '\${{amount}}' : FORMAT);
    var items = cart.items.slice();
    if (BUG==='drop-second') items = items.slice(0,1);
    var rows = items.map(function(it,n){
      var qty = it.quantity, line = it.final_line_price;
      if (BUG==='stale-qty') qty = 1;
      if (BUG==='qty-clamp' && posted && it.variant_id===posted.id){ qty = posted.quantity; line = UNIT[it.variant_id][cart.currency]*posted.quantity; }
      if (BUG==='visible-wrong-amount') line = line - 400;
      return '<tr id="CartDrawer-Item-'+(n+1)+'" class="cart-item"><td class="cart-item__details"><a href="'+esc(it.url)+'" class="cart-item__name h4 break">'+esc(it.product_title)+'</a><dl>'+
        it.options_with_values.map(function(o){return '<div class="product-option"><dt>'+esc(o.name)+': </dt><dd>'+esc(o.value)+'</dd></div>';}).join('')+'</dl></td>'+
        '<td class="cart-item__quantity"><quantity-popover><input class="quantity__input" type="number" name="updates[]" value="'+qty+'" min="0" data-index="'+(n+1)+'"></quantity-popover></td>'+
        '<td class="cart-item__totals right"><div class="cart-item__price-wrapper"><span class="price price--end">'+esc(formatMoney(line, fmt))+'</span></div></td></tr>';
    }).join('');
    var drawer=document.querySelector('cart-drawer');
    if (BUG!=='stale-drawer'){
      document.getElementById('CartDrawer-Items').innerHTML=rows;
      drawer.classList.toggle('is-empty', cart.items.length===0);
      drawer.querySelector('.drawer__inner-empty').hidden = cart.items.length>0;
      var totals=drawer.querySelector('.totals'); totals.hidden = cart.items.length===0;
      totals.querySelector('.totals__total-value').textContent = formatMoney(cart.total_price, fmt);
    }
    if (BUG!=='stale-badge'){
      var b=document.getElementById('cart-icon-bubble'); var old=b.querySelector('.cart-count-bubble'); if(old) old.remove();
      if (cart.item_count>0){ b.insertAdjacentHTML('beforeend','<div class="cart-count-bubble"><span aria-hidden="true">'+cart.item_count+'</span><span class="visually-hidden">'+cart.item_count+' items</span></div>'); }
    }
    drawer.classList.add('active');
  }
  document.getElementById('cart-icon-bubble').addEventListener('click', function(e){ e.preventDefault(); document.querySelector('cart-drawer').classList.add('active'); });
  var form=document.querySelector('product-form form');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var btn=form.querySelector('button[name="add"]'); btn.disabled=true;
    var id=Number(form.querySelector('input[name="id"]').value);
    if (BUG==='wrong-variant') id=FIRST;
    var q=document.querySelector('input.quantity__input[name="quantity"]');
    var posted={id:id, quantity: Number(q ? q.value : 1)};
    fetch(ROOT+'cart/add.js',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({items:[posted]})})
      .then(function(r){ if(!r.ok) throw new Error('add '+r.status); return fetch(ROOT+'cart.js',{headers:{Accept:'application/json'}}); })
      .then(function(r){ return r.json(); })
      .then(function(cart){ render(cart, posted); })
      .catch(function(err){ console.error(err); })
      .finally(function(){ btn.disabled=false; });
  });
})();
</script>`;
}

function productPage(sc: Scenario, root: string, mkt: string, product: Product, variantId: number, cart: ReturnType<typeof cartJson>): string {
  const m = MARKETS[mkt];
  const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  const price = formatMoney(variant.prices[m.currency], m.format);
  if (sc === 'non-dawn') {
    const body = `<h1>${esc(product.title)}</h1><p class="product-single__price">${esc(price)}</p>
<form method="post" action="${root}cart/add" id="AddToCartForm"><select name="id">${product.variants.map((v) => `<option value="${v.id}"${v.id === variant.id ? ' selected' : ''}>${esc(v.title)}</option>`).join('')}</select>
<input type="number" name="quantity" value="1"><button type="submit" id="AddToCart">Add to cart</button></form>`;
    return shell({ sc, root, mkt, currency: m.currency, schema: 'Debut', title: product.title, body, cart, format: m.format });
  }
  const body = `<h1 class="product__title">${esc(product.title)}</h1>
<div class="price"><span class="price-item price-item--regular">${esc(price)}</span></div>
${product.variants.length > 1 ? `<variant-selects><fieldset><legend>Color</legend>${product.variants.map((v) => `<a href="${root}products/${product.handle}?variant=${v.id}">${esc(v.title)}</a>`).join(' · ')}</fieldset></variant-selects>` : ''}
<quantity-input class="quantity"><label for="Quantity-main">Quantity</label><input class="quantity__input" type="number" name="quantity" id="Quantity-main" min="1" value="1" form="product-form-main"></quantity-input>
<product-form class="product-form"><form method="post" action="${root}cart/add" id="product-form-main" class="form" data-type="add-to-cart-form">
<input type="hidden" name="id" value="${variant.id}" class="product-variant-id">
<button type="submit" name="add" class="product-form__submit button button--full-width">Add to cart</button></form></product-form>`;
  return shell({ sc, root, mkt, currency: m.currency, schema: 'Dawn', title: product.title, body: body + clientScript(sc, root, m.format, product.variants), cart, format: m.format });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

export interface FixtureOptions { hangSignal?: AbortSignal }

export async function handle(req: Request, opts: FixtureOptions = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/' || url.pathname === '') {
    const links = SCENARIOS.map((s) => `<li><a href="/s/${s}/products/linen-shirt?variant=4101&country=IE">${s}</a></li>`).join('');
    return html(`<!doctype html><meta charset="utf-8"><title>MarketCart CI fixture</title><h1>MarketCart CI synthetic fixture</h1><p>Each scenario plants one known cart defect.</p><ul>${links}</ul>`);
  }
  if (url.pathname === '/password') {
    const unlocked = cookies(req).storefront_digest === DIGEST;
    const page = (err: string) => html(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Opening soon</title><h1>Fixture Store — password</h1>${err}<form method="post" action="/password" id="login_form" accept-charset="UTF-8"><input type="hidden" name="form_type" value="storefront_password"><input type="password" name="password" id="Password" autocomplete="off"><button type="submit" name="commit">Enter</button></form>`);
    if (req.method === 'GET') return unlocked ? new Response(null, { status: 302, headers: { location: '/' } }) : page('');
    if (req.method === 'POST') {
      const fd = await req.formData();
      if (fd.get('password') === FIXTURE_STOREFRONT_PASSWORD) return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `storefront_digest=${DIGEST}; Path=/; SameSite=Lax; HttpOnly` } });
      return page('<p class="errors">Wrong password</p>');
    }
  }
  const m = url.pathname.match(/^\/s\/([a-z-]+)(\/.*)$/);
  if (!m || !(SCENARIOS as readonly string[]).includes(m[1])) return html('not found', 404);
  const sc = m[1] as Scenario;
  const rest = m[2];
  const root = `/s/${sc}/`;
  if (sc === 'password-gate' && cookies(req).storefront_digest !== DIGEST) return new Response(null, { status: 302, headers: { location: '/password' } });
  // Checkout stub for third-party tools that walk to checkout. No form fields, nothing can be paid. MarketCart never visits it.
  if (req.method === 'GET' && /^\/checkouts\//.test(rest)) {
    return html(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Checkout - Fixture Store</title><h1>Checkout (synthetic fixture stub)</h1><p>No payment is possible. Scenario ${esc(sc)}.</p>`);
  }
  if (req.method === 'POST' && rest === '/cart') return new Response(null, { status: 302, headers: { location: `${root}checkouts/fixture-stub` } });
  if (/\/account|\/payments?/.test(rest)) return html('fixture refuses account/payment paths', 403);
  const mkt = resolveMarket(req, url, sc);
  const state = readCart(req);
  const cookieBase = `Path=${root}; SameSite=Lax; HttpOnly`;
  const mktCookie = `mkt=${mkt}; ${cookieBase}`;

  if (req.method === 'GET' && /^\/products\/[a-z-]+\.js$/.test(rest)) {
    // Shopify-style product JSON (Ajax API), used by third-party tools; MarketCart reads the rendered page instead.
    const product = CATALOG.find((p) => `/products/${p.handle}.js` === rest);
    if (!product) return json({ status: 404, message: 'Not found' }, 404);
    const cur = MARKETS[mkt].currency;
    return json({
      id: 9000 + CATALOG.indexOf(product), title: product.title, handle: product.handle, available: true, price: product.variants[0].prices[cur],
      options: product.variants[0].options.map(([name]) => name), url: `${root}products/${product.handle}`,
      variants: product.variants.map((v) => ({ id: v.id, title: v.title, available: true, price: v.prices[cur], option1: v.options[0]?.[1] ?? 'Default Title', option2: v.options[1]?.[1] ?? null })),
    });
  }
  if (req.method === 'GET' && rest.startsWith('/products/')) {
    if (sc === 'challenge') return html('<!doctype html><title>Just a moment...</title><div id="challenge-running">Verify you are human</div>', 429, { 'retry-after': '60' });
    const product = CATALOG.find((p) => p.handle === rest.slice('/products/'.length));
    if (!product) return html('product not found', 404);
    const variantId = Number(url.searchParams.get('variant') ?? product.variants[0].id);
    const cart = cartJson(state, sc, root);
    return html(productPage(sc, root, mkt, product, variantId, cart), 200, { 'set-cookie': mktCookie });
  }
  if (req.method === 'GET' && rest === '/cart.js') return json(cartJson(state, sc, root));
  if (req.method === 'GET' && rest === '/cart') {
    const cart = cartJson(state, sc, root);
    const fmt = MARKETS[mkt].format;
    return html(shell({ sc, root, mkt, currency: MARKETS[mkt].currency, schema: sc === 'non-dawn' ? 'Debut' : 'Dawn', title: 'Cart', body: `<h1>Your cart</h1><cart-items><table class="cart-items"><tbody>${drawerRowsHtml(cart, fmt)}</tbody></table></cart-items><form action="${root}cart" method="post" id="cart"><button type="submit" id="checkout" name="checkout" class="cart__checkout-button button">Check out</button></form>`, cart, format: fmt }));
  }
  if (req.method === 'POST' && (rest === '/cart/add.js' || rest === '/cart/add')) {
    if (sc === 'hang') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 120_000);
        opts.hangSignal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
      });
      return json({ status: 504, message: 'fixture hang released' }, 504);
    }
    let items: { id: number; quantity: number }[] = [];
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const body = (await req.json()) as { items?: { id: number; quantity?: number }[]; id?: number; quantity?: number };
      items = (body.items ?? [{ id: Number(body.id), quantity: body.quantity }]).map((i) => ({ id: Number(i.id), quantity: Number(i.quantity ?? 1) }));
    } else {
      const fd = await req.formData();
      items = [{ id: Number(fd.get('id')), quantity: Number(fd.get('quantity') ?? 1) }];
    }
    for (const it of items) {
      if (!findVariant(it.id) || !(it.quantity >= 1 && it.quantity <= 10)) return json({ status: 422, message: 'Cart Error', description: 'variant unavailable' }, 422);
    }
    const currency = sc === 'cart-currency-usd' ? 'USD' : MARKETS[mkt].currency;
    const next: CartState = state ?? { token: `fixture-${crypto.randomUUID()}`, currency, items: [] };
    for (const it of items) {
      const existing = next.items.find((x) => x.id === it.id);
      if (existing) existing.quantity += it.quantity;
      else next.items.push({ ...it });
      if (sc === 'qty-clamp') for (const x of next.items) x.quantity = Math.min(x.quantity, 2);
    }
    const added = cartJson(next, sc, root).items.filter((i) => items.some((x) => x.id === i.id));
    return json({ items: added }, 200, { 'set-cookie': `cart=${b64(JSON.stringify(next))}; ${cookieBase}` });
  }
  return html('not found', 404);
}

export { CURRENCY_FORMAT };
