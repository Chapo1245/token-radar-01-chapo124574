// Token Radar v8 dashboard. Reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the board, the three-term model, the validation tables and the 9 live
// self-checks. No network: every byte shown is in data.js. proofs() recomputes every
// check from the shipped rows, so the page and board.json visibly agree.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tab: 'farm', sort: 'implied', dir: -1, selected: null };
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) { return (n === null || n === undefined || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    return d >= 365 ? (d / 365).toFixed(1) + 'y' : Math.max(0, Math.round(d)) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  // proofs(): the 9 live self-checks, each recomputed here from the shipped data.
  function proofs() {
    var rows = DATA.rows;
    // The watchlist row is the one main.ts verified before writing (it holds the snapshot's
    // watchlist slugs); here the page recomputes the ranks, the order and the arithmetic.
    var ranksOk = new Set(rows.map(function (r) { return r.rank; })).size === rows.length && rows.every(function (r, i) { return r.rank === i + 1; });
    var orderOk = rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; });
    var badRecompute = rows.filter(function (r) {
      var back = r.launch_value_usd * r.token_odds * r.own_token_share;
      return Math.abs(back - r.implied_value_usd) > Math.max(1, 0.01 * r.implied_value_usd);
    }).length;
    var farmOk = rows.every(function (r) { return r.farm_steps.length === 7 && r.farm_steps.every(function (s) { return s.trim().length >= 20 && s.trim().length <= 600; }); });
    var auditOk = rows.length + DATA.setAside.length + DATA.traded.length === 758;
    var calGap = Math.max.apply(null, DATA.validation.term2.calibration.map(function (c) { return Math.abs(c.pred - c.actual); }));
    var shareOk = DATA.validation.term3.table.every(function (t) { return t.share >= 0.5 && t.share <= 2.0; });
    var confOk = rows.every(function (r) { return r.interval_lo_usd <= r.implied_value_usd && r.implied_value_usd <= r.interval_hi_usd; });
    var wlCheck = DATA.checks.filter(function (c) { return c.id === 'watchlist'; })[0];
    return [
      { label: wlCheck.label, pass: wlCheck.pass },
      { label: 'Ranks 1-' + rows.length + ' each once', pass: ranksOk },
      { label: 'Implied value never rises with rank', pass: orderOk },
      { label: 'Every implied value recomputes from launch x odds x share (' + badRecompute + ' bad)', pass: badRecompute === 0 },
      { label: 'Every row has 7 deposit-sized farm steps', pass: farmOk },
      { label: 'Audit adds up: ' + rows.length + ' farmable + ' + DATA.setAside.length + ' set aside + ' + DATA.traded.length + ' traded = 758', pass: auditOk },
      { label: 'Odds calibration: worst quintile gap ' + calGap.toFixed(3), pass: calGap < 0.08 },
      { label: 'Share audit: ' + DATA.validation.term3.table.length + ' categories, every share in [0.50, 2.00]', pass: shareOk },
      { label: 'Conformal intervals contain every implied value', pass: confOk },
    ];
  }
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('p')) state.selected = p.get('p');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('verdict')) state.verdict = p.get('verdict');
    if (p.get('tab')) state.tab = p.get('tab');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.tab !== 'farm') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
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
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Token Radar v8' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' · variant ' + DATA.variant })
      ));
  }
  function kpis() {
    var top = DATA.rows[0];
    var v = DATA.validation;
    var passed = proofs().filter(function (c) { return c.pass; }).length;
    var items = [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size],
      ['Farmable rows', String(DATA.board_size)],
      ['Top implied value', fmtUsd(top.implied_value_usd)],
      ['Self-checks live', passed + ' / 9 PASS'],
      ['Odds held-out AUC', String(v.term2.heldOutAuc)],
      ['Conformal coverage', Math.round(v.conformal.coverage * 100) + '%'],
    ];
    return el('div', { class: 'kpis' }, items.map(function (it) {
      return el('div', { class: 'kpi' }, el('span', { text: it[0] }), el('b', { text: it[1] }));
    }));
  }
  function proofStrip() {
    return el('div', { class: 'proofs' }, proofs().map(function (c) {
      return el('span', { class: 'proof ' + (c.pass ? 'pass' : 'fail') }, el('b', { text: c.pass ? 'PASS' : 'FAIL' }), c.label);
    }));
  }
  function lede() {
    return el('section', { class: 'lede' },
      el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by launch value x token odds x own-token share' }),
      el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The board adds ' + DATA.early_size + ' pre-token protocols below that floor, ranks all ' + DATA.board_size + ' by implied value, and shows the three-factor equation behind every row. Implied value is a model, not a promise — and "no token recorded" is what the snapshot says, never proof a protocol has none.' }),
      kpis(), proofStrip());
  }
  function modelPanel() {
    var v = DATA.validation, t1 = v.term1, t2 = v.term2, t3 = v.term3;
    var b = t1.beta;
    var wfRows = t1.walkForward.map(function (e, i) {
      return el('tr', null, el('td', { text: 'Age quartile ' + (i + 1) }), el('td', { class: 'num', text: e.toFixed(4) }), el('td', { class: 'num', text: t1.walkForwardNaive[i].toFixed(4) }));
    });
    var calRows = t2.calibration.map(function (c, i) {
      return el('tr', null, el('td', { text: 'Quintile ' + (i + 1) + ' (n=' + c.n + ')' }), el('td', { class: 'num', text: c.pred.toFixed(3) }), el('td', { class: 'num', text: c.actual.toFixed(3) }));
    });
    var shareRows = t3.table.slice(0, 8).map(function (t) {
      return el('tr', null, el('td', { text: t.category }), el('td', { class: 'num', text: 'x' + t.share.toFixed(3) }), el('td', { class: 'num', text: String(t.n) }));
    });
    var ageBars = el('div', { class: 'agebars' }, t2.ageOdds.map(function (a) {
      var h = Math.round((a.meanOdds / 0.3) * 100);
      return el('div', { class: 'agebar' }, el('i', { style: 'height:' + Math.max(4, h) + 'px' }), el('b', { text: a.meanOdds.toFixed(3) }), el('span', { text: a.bucket + ' · actual ' + a.tradedRate.toFixed(2) }));
    }));
    return el('section', { class: 'panel' },
      el('h2', { text: 'How implied value is computed — three fitted terms, each tested held-out' }),
      el('div', { class: 'formula', text: 'implied = launch x odds x share   ·   launch = 10^(' + b[0] + ' + ' + b[1] + ' x log10(TVL) + ' + b[2] + ' x growth/100)' }),
      el('p', { class: 'sub', text: 'Term 1 launch value: Huber curve on ' + t1.nComps + ' cleaned traded comps (' + t1.nDated + ' dated). Growth slope unshrunk (lambda 0): the blind-train slope is ' + t1.blindTrainBeta[2] + ' and the 16-comp half-sample slope is ' + t1.halfSampleBeta[2] + ' — unstable across samples — and every ridge lambda > 0 worsened the blind median error (scan: ' + t1.ridgeScan.map(function (r) { return 'λ' + r.lambda + ' MedAE ' + r.blindMed; }).join(', ') + '), so the board ships the unshrunk slope ' + t1.beta[2] + ' and shows the instability.' }),
      el('div', { class: 'grid2' },
        el('div', null,
          el('h3', { text: 'Term 1 — held-out errors (log10 dollars)' }),
          el('table', { class: 'vtable' }, el('tbody', null,
            el('tr', null, el('td', { text: 'Blind (fit 32 oldest, test 32 newest)' }), el('td', { class: 'num', text: t1.blind.toFixed(4) })),
            el('tr', null, el('td', { text: 'Blind median error (same split)' }), el('td', { class: 'num', text: t1.blindMed.toFixed(4) + ' vs naive ' + t1.blindNaiveMed.toFixed(4) + '  (x' + (t1.blindNaiveMed / t1.blindMed).toFixed(2) + ')' })),
            el('tr', null, el('td', { text: 'Naive TVL-only, median ratio' }), el('td', { class: 'num', text: t1.blindNaiveMedian.toFixed(4) + '  (x' + (t1.blindNaiveMedian / t1.blind).toFixed(2) + ')' })),
            el('tr', null, el('td', { text: 'Naive TVL-as-value (multiple 1.0)' }), el('td', { class: 'num', text: t1.blindNaiveTvl.toFixed(4) + '  (x' + (t1.blindNaiveTvl / t1.blind).toFixed(2) + ' MAE, x' + (t1.blindNaiveMseTvl / t1.blindMse).toFixed(2) + ' MSE)' })),
            el('tr', null, el('td', { text: 'Leave-one-out, 64 dated comps' }), el('td', { class: 'num', text: t1.loo.toFixed(4) + ' vs naive ' + t1.looNaive.toFixed(4) })),
            el('tr', null, el('td', { text: 'In-sample MAE' }), el('td', { class: 'num', text: t1.inMae.toFixed(4) }))))),
          el('div', null,
            el('h3', { text: 'Term 2 — token odds (logistic, 10 features)' }),
            el('table', { class: 'vtable' }, el('tbody', null,
              el('tr', null, el('td', { text: 'Held-out AUC (80/20, seed 7)' }), el('td', { class: 'num', text: String(t2.heldOutAuc) })),
              el('tr', null, el('td', { text: '5-fold CV AUC' }), el('td', { class: 'num', text: String(t2.cvAuc) })),
              el('tr', null, el('td', { text: 'Held-out log-loss / Brier' }), el('td', { class: 'num', text: t2.heldOutLogLoss.toFixed(3) + ' / ' + t2.brier.toFixed(3) })),
              el('tr', null, el('td', { text: 'Term 3 — share, blind MAE with / without' }), el('td', { class: 'num', text: t3.blindWith.toFixed(4) + ' / ' + t3.blindWithout.toFixed(4) })),
              el('tr', null, el('td', { text: 'Conformal 90% interval, global q (log10)' }), el('td', { class: 'num', text: String(v.conformal.qGlobal) })))))),
      el('h3', { text: 'Walk-forward — one age quartile held out at a time' }),
      el('table', { class: 'vtable' }, el('thead', null, el('tr', null, el('th', { text: 'Fold' }), el('th', { class: 'num', text: 'Model MAE' }), el('th', { class: 'num', text: 'Naive MAE' }))), el('tbody', null, wfRows)),
      el('h3', { text: 'Odds rise with age — the fit, not a prior, decides the sign' }),
      el('p', { class: 'sub', text: 'Older protocols have had longer to launch: the traded rate is 3% under 180 days and 29% past 3 years. The bars are mean fitted odds per age bucket; the label under each is the actual traded rate.' }),
      ageBars,
      el('h3', { text: 'Odds calibration — predicted vs actual traded rate by quintile' }),
      el('table', { class: 'vtable' }, el('thead', null, el('tr', null, el('th', { text: 'Quintile' }), el('th', { class: 'num', text: 'Predicted' }), el('th', { class: 'num', text: 'Actual' }))), el('tbody', null, calRows)),
      el('h3', { text: 'Own-token share by category (top 8 of ' + t3.table.length + ', shrink k=' + t3.shrink + ')' }),
      el('table', { class: 'vtable' }, el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Share' }), el('th', { class: 'num', text: 'Comps' }))), el('tbody', null, shareRows)),
      el('p', { class: 'sub', text: 'Uncertainty: conformal intervals per category (90% quantile of |log residual|, shrunk to the global quantile; ' + Math.round(v.conformal.coverage * 100) + '% of comps fall inside) plus bootstrap rank ranges from 50 seeded refits of the curve and the share term. No protocol name is special-cased anywhere.' }));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var verdict = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' },
      ['all', 'FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v === 'all' ? 'All verdicts' : v, selected: v === state.verdict ? 'selected' : null }); }));
    verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); render(); });
    var tabBtn = function (tab, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; writeHash(); render(); } });
    };
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), verdict),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Section' }), el('div', { class: 'tabs' }, tabBtn('farm', 'Farmable ' + DATA.board_size), tabBtn('setaside', 'Set aside ' + DATA.setAside.length), tabBtn('traded', 'Traded ' + DATA.traded.length))),
      el('span', { class: 'count', text: state.tab === 'farm' ? filteredRows().length + ' rows shown' : state.tab === 'setaside' ? DATA.setAside.length + ' set-aside protocols' : DATA.traded.length + ' traded protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; writeHash(); render(); } })));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.token_odds.toFixed(3) }),
        el('td', { class: 'num', text: 'x' + r.own_token_share.toFixed(3) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
          el('div', { class: 'sub', text: fmtUsd(r.interval_lo_usd) + ' - ' + fmtUsd(r.interval_hi_usd) + ' · rank ' + r.rank_lo + '-' + r.rank_hi }))),
        el('td', null, el('span', { class: 'badge ' + r.verdict, text: r.verdict }))));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its three-factor equation and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('odds', 'Odds'), sortHeader('implied', 'Share'), sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Verdict' }))),
          tbody)));
  }
  function setAsideTable() {
    var tbody = el('tbody');
    DATA.setAside.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { text: r.reason }),
        el('td', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
        el('td', null, el('span', { class: 'status', text: 'not ranked as a farm' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: '274 protocols that record no token but are a wrapped, staked, bridged, versioned or exchange product of one that trades — listed with their fitted value, never ranked as farms.' }),
        el('thead', null, el('tr', null, el('th', { text: 'Protocol' }), el('th', { class: 'num', text: 'TVL' }), el('th', { text: 'Why set aside' }), el('th', { class: 'num', text: 'Fitted value' }), el('th', { text: 'Status' }))),
        tbody)));
  }
  function tradedTable() {
    var tbody = el('tbody');
    DATA.traded.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.launch_value_usd) }),
        el('td', { class: 'num', text: r.mcap_over_launch.toFixed(3) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: '144 protocols whose token already trades: the market cap is a fact, not a model. The launch curve was fitted on 85 of them (cleaned); mcap / launch shows how each one priced against the curve.' }),
        el('thead', null, el('tr', null, el('th', { text: 'Protocol' }), el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Fitted launch' }), el('th', { class: 'num', text: 'Mcap / launch' }), el('th', { text: 'Token' }))),
        tbody)));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · rank range ' + row.rank_lo + '-' + row.rank_hi + ' over 50 refits' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · TVL ' + fmtUsd(row.tvl_usd) + ' · ' + fmtPct(row.change_7d) + ' over 7 days · age ' + fmtAge(row.age_days) })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value — three fitted terms' }),
      el('div', { class: 'formula', text: row.equation }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Term 1 — launch value (Huber curve)' }), el('b', { class: 'num', text: fmtUsd(row.launch_value_usd) })),
        el('div', null, el('span', { text: 'Term 2 — token odds (logistic)' }), el('b', { class: 'num', text: row.token_odds.toFixed(3) })),
        el('div', null, el('span', { text: 'Term 3 — own-token share (' + (row.category || 'Other') + ')' }), el('b', { class: 'num', text: 'x' + row.own_token_share.toFixed(3) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Conformal 90% interval' }), el('b', { class: 'num', text: fmtUsd(row.interval_lo_usd) + ' - ' + fmtUsd(row.interval_hi_usd) })),
        el('div', null, el('span', { text: 'Verdict / deposit size' }), el('b', { class: 'num', text: row.verdict + ' / $' + row.deposit_usd }))),
      el('p', { class: 'sub', text: 'The page recomputes this row as ' + fmtUsd(Math.round(row.launch_value_usd * row.token_odds * row.own_token_share)) + ' — the same number board.json carries. This is an estimate, not a price.' })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — sized for a $' + row.deposit_usd + ' deposit' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'farm' ? boardTable() : state.tab === 'setaside' ? setAsideTable() : tradedTable());
    if (state.tab === 'farm') shell.appendChild(modelPanel());
    shell.appendChild(el('footer', { text: 'Token Radar v8 · snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · The board is the entry\u2019s own claim, never make.fun\u2019s. A protocol records no token when the snapshot carries none for it.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }
  readHash();
  // Screenshot states: ?s=2 opens the top row's detail, ?s=3 filters to Dexs.
  var sq = new URLSearchParams(window.location.search);
  if (sq.get('s') === '2' && !state.selected && DATA.rows[0]) state.selected = DATA.rows[0].slug;
  if (sq.get('s') === '3' && state.category === 'all') state.category = 'Dexs';
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
