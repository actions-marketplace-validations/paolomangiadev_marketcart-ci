(function () {
  var C = window.MARKETCART_CONFIG || {};
  var API = C.API_URL || '';
  // Attribution: ?src= wins and is kept for the session; otherwise the LANDING page names the source (guide-<slug>,
  // generator, direct) and is kept too, so later pages of the same visit report how the visitor arrived.
  function clip(s) { return String(s || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40); }
  var paramSrc = clip(new URLSearchParams(location.search).get('src'));
  var pathSrc = /^\/guides\/([a-z0-9-]+)/.test(location.pathname) ? 'guide-' + RegExp.$1 : (/^\/tools\//.test(location.pathname) ? 'generator' : 'direct');
  var sessionSrc = null;
  try {
    if (paramSrc) sessionStorage.setItem('mc_src', paramSrc);
    else if (!sessionStorage.getItem('mc_src')) sessionStorage.setItem('mc_src', clip(pathSrc));
    sessionSrc = sessionStorage.getItem('mc_src');
  } catch (e) {}
  var src = paramSrc || clip(sessionSrc) || clip(pathSrc) || 'direct';
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  // Anonymous random visitor id, rotated daily; never linked to a person. ?mc_self=1 marks our own browsers as excluded.
  if (new URLSearchParams(location.search).get('mc_self') === '1') store('mc_self', '1');
  var day = new Date().toISOString().slice(0, 10);
  var vid = store('mc_vid');
  if (!vid || store('mc_vid_day') !== day) {
    var a = new Uint8Array(12); (window.crypto || {}).getRandomValues && crypto.getRandomValues(a);
    vid = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store('mc_vid', vid); store('mc_vid_day', day);
  }
  function track(event) {
    if (!API || navigator.webdriver || store('mc_self') === '1') return; // automation and our own browsers are never counted
    var body = JSON.stringify({ event: event, source: src, vid: vid });
    var queued = false;
    try { queued = navigator.sendBeacon(API + '/v1/events', new Blob([body], { type: 'text/plain' })); } catch (e) {}
    if (!queued) { try { fetch(API + '/v1/events', { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(function () {}); } catch (e) {} } // never awaited: navigation is not blocked
  }
  // Qualified visit: the page stayed open 8 s and the visitor interacted (scroll, click or key).
  var interacted = false, sent = false;
  function maybeQualify() { if (!sent && interacted) { sent = true; track('qualified_visit'); } }
  ['scroll', 'click', 'keydown'].forEach(function (e) { window.addEventListener(e, function () { interacted = true; }, { once: true, passive: true }); });
  setTimeout(function () { maybeQualify(); window.addEventListener('scroll', maybeQualify, { passive: true }); window.addEventListener('click', maybeQualify); }, 8000);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Checkout CTAs: one delegated handler for every a[data-buy]; the event is queued (sendBeacon, keepalive fetch
  // fallback) BEFORE the browser follows the link, and nothing waits for it. Click covers mouse, touch, Enter and
  // Ctrl/Cmd-click; auxclick covers middle-click. External Markdown (GitHub) cannot run this code.
  function onBuy(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-buy]') : null;
    if (!a) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    if (!C.BUY_OPEN) { e.preventDefault(); return; }
    track('checkout_clicked');
  }
  document.addEventListener('click', onBuy);
  document.addEventListener('auxclick', onBuy);
  if (!C.BUY_OPEN) Array.prototype.forEach.call(document.querySelectorAll('a[data-buy]'), function (b) { b.removeAttribute('href'); b.textContent = 'Checkout opens after end-to-end verification'; b.setAttribute('aria-disabled', 'true'); });

  // ---- Playground tabs (demo / own store)
  var tabs = ['demo', 'own'];
  function selectTab(name, focus) {
    if (!$('tab-' + name)) return;
    tabs.forEach(function (n) { var on = n === name; $('tab-' + n).setAttribute('aria-selected', on ? 'true' : 'false'); $('tab-' + n).tabIndex = on ? 0 : -1; $('panel-' + n).hidden = !on; });
    if (focus) $('tab-' + name).focus();
  }
  tabs.forEach(function (n) {
    var t = $('tab-' + n); if (!t) return;
    t.addEventListener('click', function () { selectTab(n); });
    t.addEventListener('keydown', function (e) {
      var idx = tabs.indexOf(n), next = null;
      if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(idx + tabs.length - 1) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab-link]'), function (l) {
    l.addEventListener('click', function (e) {
      var pg = $('playground'); if (!pg) return;
      e.preventDefault(); selectTab(l.getAttribute('data-tab-link'));
      pg.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      if (history.replaceState) history.replaceState(null, '', '#playground');
    });
  });
  if (location.hash === '#free-check') selectTab('own'); else if (location.hash === '#demo') selectTab('demo');

  // ---- Demo
  var demoBtn = $('run-demo');
  if (demoBtn) demoBtn.addEventListener('click', function () {
    if (!API) return;
    demoBtn.disabled = true; $('demo-status').textContent = 'Running in a real browser (about 20 s)…';
    fetch(API + '/v1/demo', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.results) throw new Error(d.error || 'demo unavailable');
      $('demo-status').textContent = (d.cached ? 'Cached run from ' : 'Fresh run at ') + d.ranAt + ' · engine ' + d.engineVersion + ' · sample store';
      var tb = document.querySelector('#demo-table tbody'); tb.innerHTML = '';
      d.results.forEach(function (r) { var tr = document.createElement('tr'); tr.innerHTML = '<td>' + esc(r.caseId) + '</td><td>' + esc(r.expected) + '</td><td class="' + esc(r.status) + '">' + esc(r.status) + '</td><td>' + esc(r.reason).slice(0, 240) + '</td>'; tb.appendChild(tr); });
      $('demo-table').hidden = false;
    }).catch(function (e) {
      var m = String(e.message || e);
      $('demo-status').textContent = /budget/i.test(m) ? 'Today’s free demo budget is used up, so no fresh run is available. This is a usage limit, not a product failure. It resets at midnight UTC.' : 'Demo unavailable right now: ' + m;
    }).then(function () { demoBtn.disabled = false; });
  });

  // ---- Own store: tag, copy, run
  var tokBtn = $('fc-token'), copyBtn = $('fc-copy');
  if (tokBtn) tokBtn.addEventListener('click', function () {
    var host = ($('fc-host').value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) { $('fc-meta').hidden = false; $('fc-meta').textContent = 'Enter your store host first, for example your-store.myshopify.com'; return; }
    fetch(API + '/v1/free-token?host=' + encodeURIComponent(host)).then(function (r) { return r.json(); }).then(function (d) {
      $('fc-meta').hidden = false; $('fc-meta').textContent = d.meta || d.error || 'Could not get a tag right now.';
      if (copyBtn) copyBtn.hidden = !d.meta;
    }).catch(function () { $('fc-meta').hidden = false; $('fc-meta').textContent = 'Could not reach the service. Try again in a moment.'; });
  });
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var t = $('fc-meta').textContent;
    function done(ok) { copyBtn.textContent = ok ? 'Copied' : 'Select the tag and copy it'; setTimeout(function () { copyBtn.textContent = 'Copy tag'; }, 2000); }
    try { navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
  });
  var runBtn = $('fc-run');
  if (runBtn) runBtn.addEventListener('click', function () {
    var body = { url: $('fc-url').value.trim(), variantId: Number($('fc-variant').value), quantity: Number($('fc-qty').value || 1), market: { country: $('fc-country').value.trim().toUpperCase(), currency: $('fc-currency').value.trim().toUpperCase() }, source: src };
    var pw = $('fc-pw').value; if (pw) body.storefrontPassword = pw;
    runBtn.disabled = true; $('fc-status').textContent = 'Running (up to a minute)…';
    fetch(API + '/v1/free-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (d) {
      $('fc-pw').value = '';
      $('fc-out').hidden = false;
      if (d.result) {
        $('fc-status').innerHTML = '<span class="' + esc(d.result.status) + '">' + esc(d.result.status) + '</span>' + (d.freeCheckUsed ? ' · free case used' : ' · inconclusive, free case not used');
        $('fc-out').textContent = JSON.stringify(d.result, null, 2);
      } else {
        var m = String(d.error || 'failed');
        $('fc-status').textContent = /budget/i.test(m) ? 'The shared daily free budget is used up. This is a usage limit, not a problem with your store. It resets at midnight UTC; your free case was not used.' : /already used/i.test(m) ? 'This store already used its free check. A hosted pack gives you more.' : m;
        $('fc-out').textContent = d.hint || '';
      }
    }).catch(function (e) { $('fc-status').textContent = e.message; }).then(function () { runBtn.disabled = false; });
  });
})();
