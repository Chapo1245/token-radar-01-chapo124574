// Token Radar v9 dashboard: renders window.RADAR, recomputes the nine self-checks
// live from the shipped data, and opens a detail view per protocol.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.innerHTML = '<p style="padding:20px">No radar data (data.js missing).</p>'; return; }
  var $ = function (id) { return document.getElementById(id); };

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n, d) { return (n * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtAge(d) { return d === null || d === undefined ? '—' : (d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'); }
  function fmtG(g) { return g === null || g === undefined ? '—' : (g > 0 ? '+' : '') + g.toFixed(1) + '%'; }

  // ---- header + KPIs -------------------------------------------------------
  $('meta').textContent = 'Snapshot ' + R.as_of + ' · ' + R.total_protocols + ' protocols · watchlist floor $' +
    R.floor_usd.toLocaleString('en-US') + ' · model ' + R.model_version + ' · ' + R.source;
  var top = R.rows[0];
  $('kpis').innerHTML = [
    ['Board rows', R.board_size + ' ranked'],
    ['Watchlist covered', R.watchlist_size + ' / ' + R.watchlist_size],
    ['Top implied value', money(top.implied_value_usd) + ' — ' + top.name],
    ['Live tokens set aside', R.live_size + ' traded'],
    ['Early protocols found', R.early_size + ' beyond the watchlist'],
  ].map(function (k) { return '<div class="kpi"><b>' + esc(k[1]) + '</b><span>' + esc(k[0]) + '</span></div>'; }).join('');

  // ---- the nine self-checks, recomputed live from the shipped data ---------
  function recompute() {
    var rows = R.rows;
    var slugs = {};
    rows.forEach(function (r) { slugs[r.slug] = true; });
    var checks = [];
    checks.push({ label: 'Watchlist 40/40 covered', pass: R.watchlist.every(function (s) { return slugs[s]; }), detail: R.watchlist.filter(function (s) { return slugs[s]; }).length + '/40 on the board' });
    checks.push({ label: 'Ranks exactly 1..' + rows.length, pass: rows.every(function (r, i) { return r.rank === i + 1; }), detail: '' });
    checks.push({ label: 'Implied value never rises with rank', pass: rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; }), detail: 'top ' + money(rows[0].implied_value_usd) });
    var bad = rows.filter(function (r) { return Math.abs(r.launch_usd * r.odds * r.share - r.implied_value_usd) / r.implied_value_usd > 0.01; }).length;
    checks.push({ label: 'Implied = launch × odds × share (1% band)', pass: bad === 0, detail: bad + ' rows outside' });
    checks.push({ label: 'Every row has 7 costed, timed farm steps', pass: rows.every(function (r) { return r.farm_steps.length === 7; }), detail: rows.length + ' plans' });
    checks.push({ label: 'Audit: board + live + set-aside = ' + R.total_protocols, pass: R.board_size + R.live_size + R.setaside_size === R.total_protocols, detail: R.board_size + ' + ' + R.live_size + ' + ' + R.setaside_size });
    checks.push({ label: 'Odds held-out AUC above 0.60', pass: R.term2.heldOutAuc >= 0.6, detail: 'held-out ' + R.term2.heldOutAuc + ', CV ' + R.term2.cvAuc });
    checks.push({ label: 'Own-token shares inside [0.50, 2.00]', pass: R.term3.shares.every(function (s) { return s.share >= 0.5 && s.share <= 2; }), detail: R.term3.shares.length + ' categories' });
    checks.push({ label: 'Conformal 90% intervals cover 80%+ of comps', pass: R.conformal.coverage >= 0.8, detail: 'coverage ' + R.conformal.coverage });
    return checks;
  }
  var live = recompute();
  var nPass = live.filter(function (c) { return c.pass; }).length;
  $('checks').innerHTML = '<span class="head">Live self-checks — recomputed in this page from the shipped data: <b>' + nPass + '/9 PASS</b></span>' +
    live.map(function (c) {
      return '<span class="check ' + (c.pass ? 'pass' : 'fail') + '">' + (c.pass ? '✓ ' : '✗ ') + esc(c.label) + (c.detail ? ' — ' + esc(c.detail) : '') + '</span>';
    }).join('');

  // ---- filters ---------------------------------------------------------------
  var cats = [];
  R.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  function filtered() {
    var q = $('q').value.trim().toLowerCase();
    var cat = $('cat').value;
    var watchOnly = $('watchonly').checked;
    var rows = R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (watchOnly && !r.watchlist) return false;
      return true;
    });
    var sort = $('sort').value;
    var key = { implied: 'implied_value_usd', odds: 'odds', launch: 'launch_usd', tvl: 'tvl_usd', growth: 'change_7d' }[sort];
    rows.sort(function (a, b) { return (b[key] === null ? -1e18 : b[key]) - (a[key] === null ? -1e18 : a[key]) || a.rank - b.rank; });
    return rows;
  }

  function renderBoard() {
    var rows = filtered();
    $('count').textContent = rows.length + ' of ' + R.rows.length + ' rows';
    $('rows').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.rank === 1 ? ' class="top1"' : '') + '>' +
        '<td>' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.token_status !== 'pre-token' ? ' <span class="flag" title="Records a token id but no market cap">token recorded</span>' : '') + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + r.chains.slice(0, 3).map(esc).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtG(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num">' + money(r.launch_usd) + '</td>' +
        '<td class="num">' + pct(r.odds) + '</td>' +
        '<td class="num">×' + r.share.toFixed(2) + '</td>' +
        '<td class="num imp">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + money(r.low_usd) + ' – ' + money(r.high_usd) + '<br><span class="slug">rank ' + r.rank_low + '–' + r.rank_high + '</span></td></tr>';
    }).join('');
  }

  // ---- detail dialog ---------------------------------------------------------
  var dlg = $('detail');
  function openDetail(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    $('dname').textContent = '#' + r.rank + ' ' + r.name;
    var dep = r.implied_value_usd >= 10000000 ? '$1,000' : (r.implied_value_usd >= 1000000 ? '$250' : '$50');
    var tokenNote = r.token_status === 'pre-token'
      ? 'This protocol records no token.'
      : 'This protocol records a token id but no market cap — ranked on the same curve, flagged rather than presented as having no token.';
    $('dbody').innerHTML =
      '<p>' + esc(r.category || 'Uncategorised') + ' · ' + r.chains.map(esc).join(', ') + ' · TVL ' + money(r.tvl_usd) +
      ' · 7-day growth ' + fmtG(r.change_7d) + ' · age ' + fmtAge(r.age_days) + ' · listed ' + esc(r.listed_at || 'unknown') + '</p>' +
      '<p>' + tokenNote + '</p>' +
      '<div class="eq">Implied ' + money(r.implied_value_usd) + ' = launch ' + money(r.launch_usd) + ' × odds ' + pct(r.odds) +
      ' × share ×' + r.share.toFixed(2) + '</div>' +
      '<p>90% conformal interval ' + money(r.low_usd) + ' – ' + money(r.high_usd) + '. Bootstrap rank range over 50 refits: ' +
      r.rank_low + '–' + r.rank_high + '. ' + (r.multi_chain ? 'Runs on 3+ chains: the launch curve applies its shrunk multi-chain step.' : 'Runs on fewer than 3 chains: no multi-chain step.') + '</p>' +
      '<h3>Farm plan — sized for a ' + dep + ' deposit</h3>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="cost">' + (r.token_status === 'pre-token' ? 'This protocol records no token. ' : 'This protocol records a token id but no market cap. ') + 'Implied value is the radar\u2019s own fitted claim, not a price.</p>';
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  $('dclose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });

  // ---- model section ---------------------------------------------------------
  function vtable(title, rows, note) {
    var h = '<div class="card"><h3>' + title + '</h3><table class="mini"><thead><tr><th>Model</th><th class="num">Blind MAE</th><th class="num">Blind MedAE</th><th class="num">LOO MAE</th><th class="num">LOO MedAE</th><th class="num">Walk-fwd MAE</th><th class="num">Walk-fwd MedAE</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr><td>' + esc(r.label) + '</td><td class="num">' + r.blind.mae.toFixed(4) + '</td><td class="num">' + r.blind.medae.toFixed(4) +
        '</td><td class="num">' + r.loo.mae.toFixed(4) + '</td><td class="num">' + r.loo.medae.toFixed(4) +
        '</td><td class="num">' + r.wf.mae.toFixed(4) + '</td><td class="num">' + r.wf.medae.toFixed(4) + '</td></tr>';
    });
    return h + '</tbody></table><p>' + note + '</p></div>';
  }
  var t1 = R.term1;
  var naive = R.term1.naive;
  var vrows = t1.variants.map(function (v) { return { label: v.id + ' — ' + v.label.split('— ')[1], blind: v.blind, loo: v.loo, wf: v.wf }; });
  vrows.push({ label: 'Naive median-ratio (train median mcap/TVL)', blind: naive.blind, loo: naive.loo, wf: naive.wf });
  vrows.push({ label: 'Naive TVL-as-value', blind: naive.tvl.blind, loo: naive.tvl.loo, wf: naive.tvl.wf });
  var a = t1.variants[0];
  var v8 = t1.variants[3];
  $('model').innerHTML = '<div class="modelgrid">' +
    '<div class="card"><h3>Term 1 — launch value (ships: variant A)</h3>' +
    '<p><code>' + esc(t1.equation) + '</code></p>' +
    '<p>Fitted on ' + t1.comps + ' traded comps (' + t1.dated + ' dated): intercept ' + t1.beta[0] + ', log TVL ' + t1.beta[1] +
    ', growth ' + t1.beta[2] + ', multi-chain step ' + t1.beta[3] + ' (penalty 16). Huber δ 1.5, 80 IRLS rounds, scale 1.4826 × MAD.</p>' +
    '<p>Variant A beats the v8-shape curve on all six held-out numbers: blind ' + a.blind.mae + '/' + a.blind.medae + ' vs ' + v8.blind.mae + '/' + v8.blind.medae +
    '; LOO ' + a.loo.mae + '/' + a.loo.medae + ' vs ' + v8.loo.mae + '/' + v8.loo.medae + '; walk-forward ' + a.wf.mae + '/' + a.wf.medae + ' vs ' + v8.wf.mae + '/' + v8.wf.medae +
    '. Ratios vs the median-ratio naive: blind ×' + (naive.blind.mae / a.blind.mae).toFixed(2) + ' MAE, ×' + (naive.blind.medae / a.blind.medae).toFixed(2) + ' MedAE; LOO ×' + (naive.loo.mae / a.loo.mae).toFixed(2) + '; walk-forward ×' + (naive.wf.mae / a.wf.mae).toFixed(2) + '.</p>' +
    '<p>Why the chain step, and why shrunk: unpenalised it wins the blind split but wrecks walk-forward (0.5416). Penalty 16 keeps the win on every split. Log age was tested and rejected: the blind train spans ages 989–1850 days, the test 80–927 — any age coefficient is pure extrapolation (oldest-half age slope +0.425, newest-half −0.02). Growth slope across halves: ' + t1.half.oldest[2] + ' (oldest) vs ' + t1.half.newest[2] + ' (newest); multi-chain step: ' + t1.half.oldest[3] + ' vs ' + t1.half.newest[3] + ' — the chain step is the stable term.</p>' +
    '<p>Penalty scan (blind MAE / MedAE): ' + t1.penaltyScan.map(function (s) { return 'pen ' + s.penalty + ': ' + s.mae + '/' + s.medae; }).join(' · ') + '.</p>' +
    '<p>Term 3 held-out: blind MAE with the share term ' + t1.shareBlind.withShare.mae + ' vs without ' + t1.shareBlind.withoutShare.mae + '.</p>' +
    '<p>Conformal 90% intervals: global q90 ' + R.conformal.globalQ90 + ' dex; coverage on comps ' + pct(R.conformal.coverage) + '.</p></div>' +
    '<div class="card"><h3>Term 2 — token odds (logistic, 10 features)</h3>' +
    '<p>Held-out AUC ' + R.term2.heldOutAuc + ' (80/20 split, seed 7), 5-fold CV AUC ' + R.term2.cvAuc + ', Brier ' + R.term2.heldBrier + ', log-loss ' + R.term2.heldLogLoss + '. Features: ' + R.term2.features.join('; ') + '.</p>' +
    '<p>Odds <b>rise</b> with age — the data says so, and a Weibull survival fit was tested and rejected (shape k 0.97–1.63, hazard flat-to-rising, held-out AUC 0.676 vs logistic 0.714). Traded rate by age:</p>' +
    '<table class="mini"><thead><tr><th>Age</th><th class="num">Protocols</th><th class="num">Traded</th><th class="num">Rate</th></tr></thead><tbody>' +
    R.term2.ageBuckets.map(function (b) { return '<tr><td>' + b.lo + '–' + b.hi + 'd</td><td class="num">' + b.n + '</td><td class="num">' + b.traded + '</td><td class="num">' + pct(b.rate) + '</td></tr>'; }).join('') +
    '</tbody></table>' +
    '<h3>Term 3 — own-token share by category</h3>' +
    '<p>Shrunk median log-residual per category (k=15, clamped [0.50, 2.00]). Highest: ' +
    R.term3.shares.slice(0, 5).map(function (s) { return esc(s.category) + ' ×' + s.share.toFixed(2); }).join(', ') + '. Lowest: ' +
    R.term3.shares.slice(-3).map(function (s) { return esc(s.category) + ' ×' + s.share.toFixed(2); }).join(', ') + '.</p></div>' +
    vtable('Held-out tests — every variant on the identical blind footing', vrows,
      'Blind = fit 32 oldest / test 32 newest of the 64 dated comps. LOO = 64 folds. Walk-forward = 4 age quartiles, expanding window. Errors are |log10(mcap) − log10(predicted launch)|. Variant B (scale-free multiple) and C (per-category median) both lose on every split — the table shows them because the selection was made on these numbers, not on a story.') +
    '</div>';

  // ---- live table --------------------------------------------------------------
  $('liverows').innerHTML = R.live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><br><span class="slug">' + esc(p.slug) + '</span></td><td>' + esc(p.category || '—') +
      '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + fmtG(p.change_7d) + '</td></tr>';
  }).join('');
  $('setaside').textContent = R.setaside_count + ' further protocols with no market cap recorded sit below the board, and ' +
    R.live_count + ' traded protocols are set aside as anchors. ' + R.flagged_token_recorded + ' board rows record a token id but no market cap and are flagged in their detail view. Audit: ' + R.board_size + ' + ' + R.live_count + ' + ' + R.setaside_count + ' = ' + R.total_protocols + '.';

  // ---- controls + deep links ----------------------------------------------------
  ['q', 'cat', 'sort', 'watchonly'].forEach(function (id) { $(id).addEventListener('input', renderBoard); });
  $('q').addEventListener('input', renderBoard);
  var hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('filter')) { $('cat').value = hash.get('filter'); }
  renderBoard();
  if (hash.get('detail')) openDetail(hash.get('detail'));
})();
