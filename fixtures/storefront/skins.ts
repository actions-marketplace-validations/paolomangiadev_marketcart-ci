// Version-pinned theme skins for the synthetic fixture (theme/surface matrix). The legacy skin used by the frozen
// 20-case benchmark lives in app.ts and is not touched. Markup mirrors the official theme sources:
//   dawn15 / dawn16: Shopify/dawn v15.4.1 / v16.1.1 (v16 wraps the line name in div.cart-item__title).
//                    "-page" = Dawn's default "notification" cart type: no <cart-drawer>; the cart page is the surface.
//   horizon44:       Shopify/horizon v4.4.0 (theme-drawer#cart-drawer > dialog, cart-items__table-row,
//                    cart-bubble__text-count, cart-totals__total-value, product-form-component, add-to-cart-component).
// SYNTHETIC: same author as the engine; proves the adapters read these markups, not that every store behaves alike.

export const SKINS = ['dawn15-drawer', 'dawn15-page', 'dawn16-drawer', 'dawn16-page', 'horizon44-drawer', 'horizon44-page'] as const;
export type Skin = (typeof SKINS)[number];

export interface SkinInfo { family: 'dawn' | 'horizon'; schema: string; version: string; drawer: boolean; dawn16: boolean }
export function skinInfo(skin: Skin): SkinInfo {
  const [f, s] = skin.split('-');
  const horizon = f === 'horizon44';
  return { family: horizon ? 'horizon' : 'dawn', schema: horizon ? 'Horizon' : 'Dawn', version: horizon ? '4.4.0' : f === 'dawn15' ? '15.4.1' : '16.1.1', drawer: s === 'drawer', dawn16: f === 'dawn16' };
}

interface Line { variant_id: number; quantity: number; product_title: string; url: string; final_line_price: number; options_with_values: { name: string; value: string }[] }
interface CartLike { currency: string; item_count: number; total_price: number; items: Line[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Visible-state bugs shared by server render (cart page) and client render (drawer). Stale-* bugs are drawer-only.
export function visibleLines(cart: CartLike, bug: string): { line: Line; qty: number; amount: number }[] {
  let items = cart.items.slice();
  if (bug === 'drop-second') items = items.slice(0, 1);
  return items.map((line) => ({ line, qty: bug === 'stale-qty' ? 1 : line.quantity, amount: bug === 'visible-wrong-amount' ? line.final_line_price - 400 : line.final_line_price }));
}

export function rowsHtml(skin: Skin, cart: CartLike, bug: string, money: (cents: number) => string): string {
  const info = skinInfo(skin);
  return visibleLines(cart, bug).map(({ line, qty, amount }, n) => {
    if (info.family === 'horizon') {
      const opts = line.options_with_values.map((o, i, a) => `<div class="cart-items__variant"><dt class="visually-hidden">${esc(o.name)}:</dt><dd>${esc(o.value)}${i < a.length - 1 ? ',&nbsp;' : ''}</dd></div>`).join('');
      return `<tr id="CartItem-${n + 1}" role="row" class="cart-items__table-row"><td class="cart-items__details" role="cell"><div class="cart-items__product-info"><div class="cart-items__title-row"><a href="${esc(line.url)}" class="cart-items__title">${esc(line.product_title)}</a></div></div><div class="cart-items__variants-wrapper">${opts ? `<dl class="cart-items__variants">${opts}</dl>` : ''}</div></td><td class="cart-items__quantity" role="cell"><div class="quantity-selector"><input type="number" name="updates[]" value="${qty}" min="0"></div></td><td class="cart-items__price cart-secondary-typography" role="cell"><text-component value="${esc(money(amount))}"><bdi>${esc(money(amount))}</bdi></text-component></td></tr>`;
    }
    const name = `<a href="${esc(line.url)}" class="cart-item__name h4 break">${esc(line.product_title)}</a>`;
    return `<tr id="CartItem-${n + 1}" class="cart-item"><td class="cart-item__details">${info.dawn16 ? `<div class="cart-item__title">${name}</div>` : name}<dl>${line.options_with_values.map((o) => `<div class="product-option"><dt>${esc(o.name)}: </dt><dd>${esc(o.value)}</dd></div>`).join('')}</dl></td><td class="cart-item__quantity"><quantity-popover><input class="quantity__input" type="number" name="updates[]" value="${qty}" min="0"></quantity-popover></td><td class="cart-item__totals right"><div class="cart-item__price-wrapper"><span class="price price--end">${esc(money(amount))}</span></div></td></tr>`;
  }).join('');
}

export function headerHtml(skin: Skin, root: string, count: number): string {
  const info = skinInfo(skin);
  if (info.family === 'horizon') {
    const bubble = `<span class="cart-bubble${count === 0 ? ' visually-hidden' : ''}"><span class="cart-bubble__text"><span class="cart-bubble__text-count${count === 0 ? ' hidden' : ''}" data-testid="cart-bubble" aria-hidden="true">${count || ''}</span></span></span>`;
    return info.drawer
      ? `<header class="header"><a href="${root}">Fixture Store</a><button class="header-actions__action" aria-haspopup="dialog" aria-controls="cart-drawer" data-testid="cart-drawer-trigger">Cart ${bubble}</button></header>`
      : `<header class="header"><a href="${root}">Fixture Store</a><a href="${root}cart" class="header-actions__action action__cart">Cart ${bubble}</a></header>`;
  }
  const bubble = count > 0 ? `<div class="cart-count-bubble"><span aria-hidden="true">${count}</span><span class="visually-hidden">${count} items</span></div>` : '';
  return `<header class="header"><a href="${root}">Fixture Store</a><a id="cart-icon-bubble" class="header__icon header__icon--cart" href="${root}cart">Cart${bubble}</a></header>`;
}

export function totalHtml(skin: Skin, total: string, empty: boolean): string {
  return skinInfo(skin).family === 'horizon'
    ? `<div class="cart-totals"><span class="cart-totals__total-label">Estimated total</span> <text-component class="cart-totals__total-value" data-testid="cart-total-value"><bdi>${esc(total)}</bdi></text-component></div>`
    : `<div class="totals"${empty ? ' hidden' : ''}><h2 class="totals__total">Estimated total</h2><p class="totals__total-value">${esc(total)}</p></div>`;
}

export function drawerHtml(skin: Skin, rows: string, total: string, empty: boolean): string {
  const info = skinInfo(skin);
  if (!info.drawer) return '';
  if (info.family === 'horizon') {
    return `<theme-drawer id="cart-drawer"><dialog class="theme-drawer__dialog" aria-labelledby="cart-drawer-heading"><cart-drawer-component><div class="cart-drawer__inner${empty ? ' cart-drawer--empty' : ''}"><h2 id="cart-drawer-heading">Cart</h2><div class="cart-drawer__items"><table class="cart-items__table"><tbody id="HorizonDrawerRows">${rows}</tbody></table></div><div class="cart-drawer__summary">${totalHtml(skin, total, empty)}</div></div></cart-drawer-component></dialog></theme-drawer>`;
  }
  return `<cart-drawer class="drawer${empty ? ' is-empty' : ''}"><div id="CartDrawer" class="cart-drawer"><div class="drawer__inner"><div class="drawer__header"><h2 class="drawer__heading">Your cart</h2></div><cart-drawer-items><table class="cart-items"><tbody id="CartDrawer-Items">${rows}</tbody></table></cart-drawer-items>${totalHtml(skin, total, empty)}</div></div></cart-drawer>`;
}

export function productFormHtml(skin: Skin, root: string, variantId: number): string {
  if (skinInfo(skin).family === 'horizon') {
    return `<product-form-component><form method="post" action="${root}cart/add" id="BuyButtons-ProductForm" data-type="add-to-cart-form"><input type="hidden" name="id" value="${variantId}"><quantity-selector-component><input type="number" name="quantity" value="1" min="1"></quantity-selector-component><add-to-cart-component><button type="submit" name="add" class="button add-to-cart-button">Add to cart</button></add-to-cart-component></form></product-form-component>`;
  }
  return `<quantity-input class="quantity"><input class="quantity__input" type="number" name="quantity" id="Quantity-main" min="1" value="1" form="product-form-main"></quantity-input><product-form class="product-form"><form method="post" action="${root}cart/add" id="product-form-main" class="form" data-type="add-to-cart-form"><input type="hidden" name="id" value="${variantId}" class="product-variant-id"><button type="submit" name="add" class="product-form__submit button button--full-width">Add to cart</button></form></product-form>`;
}

// Client behaviour per skin: add via Ajax, then (drawer skins) re-render and open the drawer, or (page skins)
// update the header count only, like Dawn's notification popup. Bugs: wrong-variant, stale-drawer, stale-badge, and
// the visible-state bugs from visibleLines (client copy below).
export function skinClientScript(skin: Skin, bug: string, root: string, formatFn: string, format: string, firstVariant: number): string {
  const info = skinInfo(skin);
  return `<script>
(function(){
  var BUG=${JSON.stringify(bug)}, ROOT=${JSON.stringify(root)}, FAMILY=${JSON.stringify(info.family)}, DRAWER=${info.drawer}, DAWN16=${info.dawn16}, FORMAT=${JSON.stringify(format)}, FIRST=${firstVariant};
  var formatMoney=${formatFn};
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function lines(cart){ var items=cart.items.slice(); if(BUG==='drop-second') items=items.slice(0,1);
    return items.map(function(l){ return {l:l, qty: BUG==='stale-qty'?1:l.quantity, amount: BUG==='visible-wrong-amount'? l.final_line_price-400 : l.final_line_price}; }); }
  function rows(cart){ return lines(cart).map(function(x,n){ var l=x.l;
    if(FAMILY==='horizon'){ var o=l.options_with_values.map(function(v,i,a){return '<div class="cart-items__variant"><dt class="visually-hidden">'+esc(v.name)+':</dt><dd>'+esc(v.value)+(i<a.length-1?',&nbsp;':'')+'</dd></div>';}).join('');
      return '<tr class="cart-items__table-row"><td class="cart-items__details"><div class="cart-items__title-row"><a href="'+esc(l.url)+'" class="cart-items__title">'+esc(l.product_title)+'</a></div><div class="cart-items__variants-wrapper">'+(o?'<dl class="cart-items__variants">'+o+'</dl>':'')+'</div></td><td class="cart-items__quantity"><input type="number" name="updates[]" value="'+x.qty+'"></td><td class="cart-items__price"><text-component><bdi>'+esc(formatMoney(x.amount,FORMAT))+'</bdi></text-component></td></tr>'; }
    var name='<a href="'+esc(l.url)+'" class="cart-item__name h4 break">'+esc(l.product_title)+'</a>';
    return '<tr class="cart-item"><td class="cart-item__details">'+(DAWN16?'<div class="cart-item__title">'+name+'</div>':name)+'<dl>'+l.options_with_values.map(function(v){return '<div class="product-option"><dt>'+esc(v.name)+': </dt><dd>'+esc(v.value)+'</dd></div>';}).join('')+'</dl></td><td class="cart-item__quantity"><input class="quantity__input" type="number" name="updates[]" value="'+x.qty+'"></td><td class="cart-item__totals right"><div class="cart-item__price-wrapper"><span class="price price--end">'+esc(formatMoney(x.amount,FORMAT))+'</span></div></td></tr>'; }).join(''); }
  function badge(cart){ if(BUG==='stale-badge') return;
    if(FAMILY==='horizon'){ var c=document.querySelector('.cart-bubble__text-count'); c.textContent=cart.item_count||''; c.classList.toggle('hidden',cart.item_count===0); c.closest('.cart-bubble').classList.toggle('visually-hidden',cart.item_count===0); return; }
    var b=document.getElementById('cart-icon-bubble'); var old=b.querySelector('.cart-count-bubble'); if(old) old.remove();
    if(cart.item_count>0) b.insertAdjacentHTML('beforeend','<div class="cart-count-bubble"><span aria-hidden="true">'+cart.item_count+'</span><span class="visually-hidden">'+cart.item_count+' items</span></div>'); }
  function openDrawer(){ if(FAMILY==='horizon'){ var d=document.querySelector('theme-drawer#cart-drawer dialog'); if(d && !d.open) d.show(); } else { document.querySelector('cart-drawer').classList.add('active'); } }
  function render(cart){
    if(DRAWER && BUG!=='stale-drawer'){
      if(FAMILY==='horizon'){ document.getElementById('HorizonDrawerRows').innerHTML=rows(cart); var t=document.querySelector('theme-drawer .cart-totals__total-value bdi'); if(t) t.textContent=formatMoney(cart.total_price,FORMAT); }
      else { document.getElementById('CartDrawer-Items').innerHTML=rows(cart); var tv=document.querySelector('cart-drawer .totals__total-value'); var to=document.querySelector('cart-drawer .totals'); if(tv){tv.textContent=formatMoney(cart.total_price,FORMAT);} if(to){to.hidden=cart.items.length===0;} }
    }
    badge(cart);
    if(DRAWER && BUG!=='drawer-no-open') openDrawer();
  }
  var trigger=document.querySelector(FAMILY==='horizon'?'[data-testid="cart-drawer-trigger"]':'#cart-icon-bubble');
  if(trigger && DRAWER) trigger.addEventListener('click',function(e){ e.preventDefault(); openDrawer(); });
  var form=document.querySelector('form[data-type="add-to-cart-form"]');
  form.addEventListener('submit',function(e){ e.preventDefault();
    var id=Number(form.querySelector('input[name="id"]').value); if(BUG==='wrong-variant') id=FIRST;
    var q=document.querySelector(FAMILY==='horizon'?'quantity-selector-component input[name="quantity"]':'input.quantity__input[name="quantity"]');
    fetch(ROOT+'cart/add.js',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({items:[{id:id,quantity:Number(q?q.value:1)}]})})
      .then(function(r){ if(!r.ok) throw new Error('add '+r.status); return fetch(ROOT+'cart.js',{headers:{Accept:'application/json'}}); })
      .then(function(r){ return r.json(); }).then(render).catch(function(err){ console.error(err); });
  });
})();
</script>`;
}
