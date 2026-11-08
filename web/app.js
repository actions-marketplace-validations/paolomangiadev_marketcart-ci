(function () {
  var C = window.MARKETCART_CONFIG || {};
  var API = C.API_URL || '';
  // Attribution: ?src= wins and is kept for the session (first touch); otherwise the landing path names the source.
  function clip(s) { return String(s || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40); }
  var paramSrc = clip(new URLSearchParams(location.search).get('src'));
  var sessionSrc = null;
  try { if (paramSrc) sessionStorage.setItem('mc_src', paramSrc); sessionSrc = sessionStorage.getItem('mc_src'); } catch (e) {}
  var pathSrc = /^\/guides\/([a-z0-9-]+)/.test(location.pathname) ? 'guide-' + RegExp.$1 : (/^\/tools\//.test(location.pathname) ? 'generator' : 'direct');
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
    try { navigator.sendBeacon(API + '/v1/events', new Blob([JSON.stringify({ event: event, source: src, vid: vid })], { type: 'text/plain' })); } catch (e) {}
  }
  // Qualified visit: the page stayed open 8 s and the visitor interacted (scroll, click or key).
  var interacted = false, sent = false;
  function maybeQualify() { if (!sent && interacted) { sent = true; track('qualified_visit'); } }
  ['scroll', 'click', 'keydown'].forEach(function (e) { window.addEventListener(e, function () { interacted = true; }, { once: true, passive: true }); });
  setTimeout(function () { maybeQualify(); window.addEventListener('scroll', maybeQualify, { passive: true }); window.addEventListener('click', maybeQualify); }, 8000);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  var demoBtn = $('run-demo');
  if (demoBtn) demoBtn.addEventListener('click', function () {
    if (!API) return;
    demoBtn.disabled = true; $('demo-status').textContent = 'Running in a real browser (about 20 s)…';
    fetch(API + '/v1/demo', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.results) throw new Error(d.error || 'demo unavailable');
      $('demo-status').textContent = (d.cached ? 'Cached run from ' : 'Fresh run at ') + d.ranAt + ' · engine ' + d.engineVersion + ' · synthetic fixture';
      var tb = document.querySelector('#demo-table tbody'); tb.innerHTML = '';
      d.results.forEach(function (r) { var tr = document.createElement('tr'); tr.innerHTML = '<td>' + esc(r.caseId) + '</td><td>' + esc(r.expected) + '</td><td class="' + esc(r.status) + '">' + esc(r.status) + '</td><td>' + esc(r.reason).slice(0, 240) + '</td>'; tb.appendChild(tr); });
      $('demo-table').hidden = false;
    }).catch(function (e) { $('demo-status').textContent = 'Demo unavailable: ' + e.message; }).then(function () { demoBtn.disabled = false; });
  });

  var tokBtn = $('fc-token');
  if (tokBtn) tokBtn.addEventListener('click', function () {
    var host = ($('fc-host').value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) return;
    fetch(API + '/v1/free-token?host=' + encodeURIComponent(host)).then(function (r) { return r.json(); }).then(function (d) {
      $('fc-meta').hidden = false; $('fc-meta').textContent = d.meta || d.error;
    });
  });
  var runBtn = $('fc-run');
  if (runBtn) runBtn.addEventListener('click', function () {
    var body = { url: $('fc-url').value.trim(), variantId: Number($('fc-variant').value), quantity: Number($('fc-qty').value || 1), market: { country: $('fc-country').value.trim().toUpperCase(), currency: $('fc-currency').value.trim().toUpperCase() }, source: src };
    var pw = $('fc-pw').value; if (pw) body.storefrontPassword = pw;
    runBtn.disabled = true; $('fc-status').textContent = 'Running (up to a minute)…';
    fetch(API + '/v1/free-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (d) {
      $('fc-pw').value = '';
      $('fc-out').hidden = false;
      if (d.result) { $('fc-status').innerHTML = '<span class="' + esc(d.result.status) + '">' + esc(d.result.status) + '</span>' + (d.freeCheckUsed ? ' · free case used' : ' · inconclusive, free case not used'); $('fc-out').textContent = JSON.stringify(d.result, null, 2); }
      else { $('fc-status').textContent = d.error || 'failed'; $('fc-out').textContent = d.hint || ''; }
    }).catch(function (e) { $('fc-status').textContent = e.message; }).then(function () { runBtn.disabled = false; });
  });

  var buy = $('buy-link');
  if (buy) buy.addEventListener('click', function () { track('checkout_clicked'); });
  if (!C.BUY_OPEN && buy) { buy.removeAttribute('href'); buy.textContent = 'Checkout opens after end-to-end verification'; buy.classList.add('muted'); }
})();
