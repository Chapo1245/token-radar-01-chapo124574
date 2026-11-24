// Token Radar v7 — the page. Reads window.RADAR (written beside it by
// main.ts) and renders the board, the set-aside and traded sections, and a
// detail view per protocol. No network: every byte shown is in data.js.
// The page re-checks the board it shows: it recomputes each row's launch
// value from the fitted curve and its implied value as launch x odds, and
// the proof strip at the top shows the six checks live.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tab: 'farm', sort: 'implied', dir: -1, selected: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d == null) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.round(d) + 'd';
  }
  function fmtX(e) { return 'x' + Math.pow(10, e).toFixed(2); }
  function growthOf(r) {
    var g = r.change_7d == null ? 0 : r.change_7d;
    return Math.min(120, Math.max(-60, g)) / 100;
  }
  function launchOf(r) {
    var c = DATA.curve;
    return Math.pow(10, c.intercept + c.tvlSlope * (Math.log(r.tvl_usd) / Math.LN10) + c.growthSlope * growthOf(r));
  }

  // Six live self-checks. Each is computed here, from the same data the
  // table shows, and each can fail: a failing strip means the page and
  // the board disagree, and the reader should trust neither.
  function proofs() {
    var rows = DATA.rows;
    var slugs = {};
    rows.forEach(function (r) { slugs[r.slug] = true; });
    var watchOk = DATA.watchlist.every(function (s) { return slugs[s]; });
    var rankOk = rows.every(function (r, i) { return r.rank === i + 1; });
    var orderOk = rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; });
    var stepsOk = rows.every(function (r) { return r.farm_steps.length >= 3 && r.farm_steps.length <= 12; });
    var recomputeOk = rows.every(function (r) {
      var launch = launchOf(r);
      if (Math.abs(launch - r.launch_value_usd) > Math.max(2, r.launch_value_usd * 0.002)) return false;
      // token_odds is stored rounded to 3 decimals, so the recompute
      // allows launch x 0.0006 of slack on top of the 0.2% band.
      var implied = Math.max(1, Math.round(launch * (r.token_odds == null ? 1 : r.token_odds)));
      return Math.abs(implied - r.implied_value_usd) <= Math.max(2, r.implied_value_usd * 0.002 + launch * 0.0006);
    });
    var auditOk = DATA.counts.farmable + DATA.counts.flagged + DATA.counts.traded === DATA.counts.scanned;
    return [
      { label: 'Watchlist ' + DATA.watchlist.length + '/' + DATA.watchlist.length, ok: watchOk },
      { label: 'Ranks 1..' + rows.length, ok: rankOk },
      { label: 'Values never rise with rank', ok: orderOk },
      { label: 'Farm plans 3-12 steps', ok: stepsOk },
      { label: 'Page recomputes every implied value', ok: recomputeOk },
      { label: 'Audit adds up: ' + DATA.counts.scanned + ' protocols', ok: auditOk },
    ];
  }

  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('verdict')) state.verdict = p.get('verdict');
    if (p.get('tab')) state.tab = p.get('tab');
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.tab !== 'farm') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    history.replaceState(null, '', next ? '#' + next : location.pathname + location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d == null ? -Infinity : a.change_7d; bv = b.change_7d == null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days == null ? Infinity : a.age_days; bv = b.age_days == null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.token_odds == null ? -1 : a.token_odds; bv = b.token_odds == null ? -1 : b.token_odds; }
      else if (key === 'launch') { av = a.launch_value_usd; bv = b.launch_value_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function sortBtn(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? ' v' : ' ^') : '';
    return '<th scope="col"><button type="button" data-sort="' + key + '">' + esc(label) + esc(arrow) + '</button></th>';
  }
  function verdictTag(v) {
    return '<span class="tag ' + v.toLowerCase() + '">' + esc(v) + '</span>';
  }
  function chainText(r) {
    return (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');
  }
  function detailChains(r) {
    var c = r.chains || [];
    if (!c.length) return 'an unnamed chain';
    return c.slice(0, 5).join(', ') + (c.length > 5 ? ' +' + (c.length - 5) + ' more' : '');
  }

  function farmTable() {
    var list = sortedRows(filteredRows());
    if (!list.length) {
      return '<div class="panel"><div class="empty"><h2>No protocol matches that filter</h2><p>Clear the search or pick another category to see the board again.</p><button class="button" type="button" id="clear">Clear filters</button></div></div>';
    }
    var max = list[0].implied_value_usd || 1;
    var rowsHtml = list.map(function (r) {
      var g = r.change_7d == null ? 'n/a' : fmtPct(r.change_7d);
      var gc = r.change_7d == null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var range = r.rank_lo === r.rank_hi ? '#' + r.rank : '#' + r.rank + ' (' + r.rank_lo + '-' + r.rank_hi + ')';
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0" class="' + (state.selected === r.slug ? 'sel' : '') + '">' +
        '<td class="num">' + r.rank + '<br><span class="note">' + esc(range) + '</span></td>' +
        '<td><div class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.category || 'Other') + ' on ' + esc(chainText(r)) + '</span></div></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + gc + '">' + g + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num">' + fmtUsd(r.launch_value_usd) + '</td>' +
        '<td class="num">' + (r.token_odds == null ? 'n/a' : r.token_odds.toFixed(3)) + '</td>' +
        '<td><div class="bar" aria-hidden="true"><i style="width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%"></i></div><span class="num">' + fmtUsd(r.implied_value_usd) + '</span></td>' +
        '<td>' + verdictTag(r.verdict) + '</td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table><caption>Pre-token protocols, strongest implied value first. Rank ranges come from 50 bootstrap refits of the curve. Select a row for its equation and farm plan.</caption><thead><tr>' +
      sortBtn('implied', 'Rank') + sortBtn('name', 'Protocol') + sortBtn('tvl', 'TVL') + sortBtn('growth', '7d') + sortBtn('age', 'Age') + sortBtn('launch', 'Launch value') + sortBtn('odds', 'Token odds') + sortBtn('implied', 'Implied value') + '<th scope="col">Verdict</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>';
  }

  function sideTable(kind) {
    var list = kind === 'flagged' ? DATA.flagged : DATA.traded;
    var rowsHtml = list.map(function (r) {
      var val = kind === 'flagged' ? fmtUsd(r.fitted_value_usd) : fmtUsd(r.mcap_usd);
      var note = kind === 'flagged' ? esc(r.reason) : 'token already trades';
      var tag = kind === 'flagged' ? '<span class="tag aside">set aside</span>' : '<span class="tag live">live</span>';
      return '<tr><td><div class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.category || 'Other') + ' on ' + esc(chainText(r)) + '</span></div></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d != null && r.change_7d < 0 ? 'neg' : 'pos') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + val + '</td><td>' + tag + ' ' + esc(note) + '</td></tr>';
    }).join('');
    var cap = kind === 'flagged'
      ? 'Wrapped, staked, bridged, versioned and exchange products: the fitted value is shown, but they are never ranked as farms.'
      : 'Protocols whose token already trades: their market cap is a fact, not a model. They are set aside from the pre-token ranking.';
    return '<div class="panel"><div class="table-wrap"><table><caption>' + cap + '</caption><thead><tr><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">7d</th><th scope="col">' + (kind === 'flagged' ? 'Fitted value' : 'Market cap') + '</th><th scope="col">Why it is here</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>';
  }

  function modelPanel() {
    var c = DATA.curve, o = DATA.odds, v = DATA.validation;
    var eq = 'log10(launch) = ' + c.intercept.toFixed(3) + ' + ' + c.tvlSlope.toFixed(3) + ' x log10(TVL) + ' + c.growthSlope.toFixed(3) + ' x growth';
    return '<section class="panel model"><h2>How implied value is computed</h2>' +
      '<p>Every row is scored by one fitted function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The curve is a Huber robust fit (delta 1.5) on ' + c.comps + ' traded comps; the odds are a logistic fit on the whole peer record (144 traded, 614 pre-token), 5-fold cross-validated AUC ' + o.cvAuc.toFixed(3) + ', log-loss ' + o.cvLogLoss.toFixed(3) + '.</p>' +
      '<div class="formula">' + esc(eq) + '<br>implied value = launch value x token odds</div>' +
      '<table class="valid"><caption>Validation: every term fitted and tested held-out. Blind fits the oldest half of the dated comps and tests the newest half; the four-way splits hold out each quarter in turn.</caption><thead><tr><th scope="col">Check</th><th scope="col">Median |log10 error|</th><th scope="col">Typical miss</th></tr></thead><tbody>' +
      '<tr><td>Blind, oldest half -&gt; newest half (' + v.blindN + ' tested)</td><td class="num">' + v.blindMedian.toFixed(4) + '</td><td class="num">' + fmtX(v.blindMedian) + '</td></tr>' +
      '<tr><td>Four-way held-out, by age quartile</td><td class="num">' + v.fourWayAge.toFixed(4) + '</td><td class="num">' + fmtX(v.fourWayAge) + '</td></tr>' +
      '<tr><td>Four-way held-out, random split (seed 7)</td><td class="num">' + v.fourWayRandom.toFixed(4) + '</td><td class="num">' + fmtX(v.fourWayRandom) + '</td></tr>' +
      '<tr><td>Leave-one-out, ' + v.looN + ' dated comps</td><td class="num">' + v.looMedian.toFixed(4) + '</td><td class="num">' + fmtX(v.looMedian) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="note">Read it plainly: the typical launch value is off by about ' + fmtX(v.blindMedian) + ', so treat every implied value as an order of magnitude with a rank range, not a price. Age is not in the launch value — held-out tests showed it hurts there — it only enters the odds, where its weight is small. A protocol records no token; the record is not proof it has none.</p></section>';
  }

  function render() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var pr = proofs();
    var html = '<div class="shell">' +
      '<header class="top"><div class="brand">Token Radar <i>v7</i></div><div class="top-meta"><span>Snapshot ' + esc(DATA.as_of) + '</span><span>DefiLlama protocol index</span><span>radar-7 model, variant ' + esc(DATA.variant) + '</span></div></header>' +
      '<section class="lede"><h1>' + DATA.counts.watchlist + ' watchlist protocols, ranked by implied value</h1>' +
      '<p>The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The radar audits all ' + DATA.counts.scanned + ' protocols in the snapshot — ' + DATA.counts.farmable + ' farmable pre-token rows ranked here, ' + DATA.counts.flagged + ' wrapped / staked / bridged products set aside with their fitted value, and ' + DATA.counts.traded + ' whose token already trades. Implied value is a model, not a promise.</p>' +
      '<div class="facts">' +
      '<div class="fact"><span>Watchlist covered</span><b>' + DATA.counts.watchlist + ' / ' + DATA.counts.watchlist + '</b></div>' +
      '<div class="fact"><span>Pre-token rows ranked</span><b>' + DATA.counts.farmable + '</b></div>' +
      '<div class="fact"><span>Verdicts FARM / THIN / SKIP</span><b>' + DATA.verdicts.farm + ' / ' + DATA.verdicts.thin + ' / ' + DATA.verdicts.skip + '</b></div>' +
      '<div class="fact"><span>Set aside</span><b>' + DATA.counts.flagged + '</b></div>' +
      '<div class="fact"><span>Already trading</span><b>' + DATA.counts.traded + '</b></div></div>' +
      '<div class="proofs">' + pr.map(function (p) { return '<span class="proof ' + (p.ok ? 'pass' : 'fail') + '"><b>' + (p.ok ? 'PASS' : 'FAIL') + '</b> ' + esc(p.label) + '</span>'; }).join('') + '</div></section>' +
      '<div class="controls">' +
      '<div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="Search name or chain" value="' + esc(state.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label><select id="category" aria-label="Filter by category"><option value="all">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="verdict">Verdict</label><select id="verdict" aria-label="Filter by verdict"><option value="all">All verdicts</option>' + ['FARM', 'THIN', 'SKIP'].map(function (v) { return '<option value="' + v + '"' + (v === state.verdict ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><span class="sub">Section</span><div class="tabs">' +
      '<button type="button" data-tab="farm" aria-pressed="' + (state.tab === 'farm') + '">Pre-token farms</button>' +
      '<button type="button" data-tab="flagged" aria-pressed="' + (state.tab === 'flagged') + '">Set aside</button>' +
      '<button type="button" data-tab="traded" aria-pressed="' + (state.tab === 'traded') + '">Already trading</button></div></div>' +
      '<span class="count">' + (state.tab === 'farm' ? filteredRows().length + ' rows shown' : state.tab === 'flagged' ? DATA.flagged.length + ' set aside' : DATA.traded.length + ' already trading') + '</span></div>' +
      (state.tab === 'farm' ? farmTable() : sideTable(state.tab)) +
      (state.tab === 'farm' ? modelPanel() : '') +
      '<p class="foot">Token Radar v7. The board is the entry&rsquo;s own claim, never make.fun&rsquo;s. A protocol on this board records no token in DefiLlama&rsquo;s snapshot; that is the record, not proof it has none. Farm at your own risk, with money you can lose.</p>' +
      '</div>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    bind();
    if (state.selected) openDetail(state.selected, false);
  }

  function bind() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    var cat = document.getElementById('category');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var ver = document.getElementById('verdict');
    if (ver) ver.addEventListener('change', function () { state.verdict = ver.value; writeHash(); render(); });
    var clear = document.getElementById('clear');
    if (clear) clear.addEventListener('click', function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; writeHash(); render(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); state.selected = null; writeHash(); render(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = -1; }
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug'), true); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(tr.getAttribute('data-slug'), true); } });
    });
  }

  var dialog = document.createElement('dialog');
  dialog.className = 'detail';
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug, fromClick) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    var range = row.rank_lo === row.rank_hi ? '#' + row.rank + ' in all 50 refits' : '#' + row.rank + ', range #' + row.rank_lo + '-#' + row.rank_hi + ' over 50 refits';
    var steps = row.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="cost">' + esc(tail) + '</span></li>';
    }).join('');
    dialog.innerHTML = '<div class="detail-head"><div><span class="brand-name">Rank ' + row.rank + ' of ' + DATA.rows.length + ' &middot; ' + esc(range) + '</span>' +
      '<h2>' + esc(row.name) + '</h2><p class="sub">' + esc(row.category || 'Other') + ' on ' + esc(detailChains(row)) + ' &middot; records no token</p></div>' +
      '<button class="close" type="button" aria-label="Close details">Close</button></div>' +
      '<section class="detail-section"><h3>Implied value, as an equation</h3><div class="equation">' +
      '<div><span>TVL</span><b class="num">' + fmtUsd(row.tvl_usd) + '</b></div>' +
      '<div><span>Seven-day growth</span><b class="num">' + fmtPct(row.change_7d) + '</b></div>' +
      '<div><span>Age with no token</span><b class="num">' + fmtAge(row.age_days) + '</b></div>' +
      '<div><span>Chains</span><b class="num">' + (row.chains || []).length + '</b></div>' +
      '<div><span>Launch value</span><b class="num">' + fmtUsd(row.launch_value_usd) + '</b></div>' +
      '<div><span>Token odds</span><b class="num">' + (row.token_odds == null ? 'n/a' : row.token_odds.toFixed(3)) + '</b></div>' +
      '<div class="total"><span>Implied value = launch x odds</span><b class="num">' + fmtUsd(row.implied_value_usd) + '</b></div></div>' +
      '<p class="sub">Verdict ' + row.verdict + ': ' + (row.verdict === 'FARM' ? 'worth farming first — the largest expected launch value on the board.' : row.verdict === 'THIN' ? 'worth a small position — the expected value is real but thin.' : 'skip for now — the expected value does not cover the time and gas.') + ' This is an estimate, not a price.</p></section>' +
      '<section class="detail-section"><h3>Farm plan</h3><ol class="steps">' + steps + '</ol></section>';
    var close = dialog.querySelector('.close');
    if (close) close.addEventListener('click', function () { dialog.close(); });
    if (!dialog.isConnected) app.appendChild(dialog);
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
    if (fromClick) { /* hash already written */ }
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
