// Token Radar v6 dashboard — renders the board data, runs the proof strip
// live in the browser, no network, no tracking.
(function () {
  var D = window.TOKEN_RADAR;
  if (!D) {
    document.body.innerHTML = '<p style="padding:40px">Board data (data.js) did not load.</p>';
    return;
  }
  var meta = D.meta;
  var variant = meta.variant || 'C';
  var rows = D.rows;
  var pre = rows.filter(function (r) { return !r.traded; });
  var farmable = pre.filter(function (r) { return !r.flag; });
  var flagged = pre.filter(function (r) { return r.flag; });
  var traded = rows.filter(function (r) { return r.traded; });

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n * 100).toFixed(0) + '%';
  }
  function chainsShort(r) {
    if (!r.chains || r.chains.length === 0) return '—';
    if (r.chains.length <= 3) return esc(r.chains.join(', '));
    return esc(r.chains.slice(0, 3).join(', ')) + ' +' + (r.chains.length - 3) + ' more';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- header
  document.getElementById('asof').textContent = meta.asOf;
  document.getElementById('asof2').textContent = meta.asOf;
  var stats = document.getElementById('stats');
  var statHtml = [
    [meta.nProtocols, 'protocols audited'],
    [meta.nFarmable, 'farmable pre-token'],
    [meta.nTraded, 'already trading'],
    [meta.nWatchlist, 'on the watchlist'],
    [meta.verdicts.farm, 'FARM verdicts'],
  ];
  stats.innerHTML = statHtml.map(function (s) {
    return '<div class="stat"><b>' + s[0] + '</b><span>' + s[1] + '</span></div>';
  }).join('');

  // ---- variant A: launch-value ranking only — no odds column, no proof
  // strip, no walk-forward table. Variant B adds odds + proofs; C adds ranges.
  if (variant === 'A') {
    document.getElementById('proofs').style.display = 'none';
    document.getElementById('walk').style.display = 'none';
    var headRow = document.querySelector('#board thead tr');
    if (headRow && headRow.children[7]) headRow.children[7].remove();
  }
  if (variant !== 'C') {
    document.getElementById('walk').style.display = 'none';
  }

  // ---- proof strip (computed live from the data)
  var checks = [];
  var wlOk = rows.filter(function (r) { return r.wl; }).length === meta.nWatchlist;
  checks.push(['Watchlist 40/40 covered', wlOk, meta.nWatchlist + ' watchlist rows present in the board']);
  var farmRanks = farmable.map(function (r) { return r.farm; }).sort(function (a, b) { return a - b; });
  var ranksOk = farmRanks.length > 0 && farmRanks.every(function (v, i) { return v === i + 1; });
  checks.push(['Farmable pre-token ranks 1..' + farmable.length + ' with no gaps', ranksOk, 'every farmable row has exactly one rank']);
  var sorted = farmable.slice().sort(function (a, b) { return a.farm - b.farm; });
  var monoOk = sorted.every(function (r, i) { return i === 0 || r.implied <= sorted[i - 1].implied; });
  checks.push(['Implied value never rises down the board', monoOk, 'rank #1 is the highest implied value, #' + farmable.length + ' the lowest']);
  var stepsOk = rows.every(function (r) { return r.steps && r.steps.length >= 3 && r.steps.length <= 12; });
  checks.push(['Every row has 3–12 farm steps', stepsOk, rows.length + ' rows checked']);
  var countOk = rows.length === meta.nProtocols && pre.length + traded.length === rows.length;
  checks.push(['Board rows = ' + meta.nProtocols + ' (snapshot size)', countOk, pre.length + ' pre-token + ' + traded.length + ' traded']);
  var oddsOk = pre.every(function (r) { return r.odds !== null && r.odds > 0 && r.odds < 1; });
  checks.push(['Token odds in (0, 1) for every pre-token row', oddsOk, 'odds are fitted probabilities, never 0 or 1']);
  document.getElementById('checks').innerHTML = checks.map(function (c) {
    return '<li><span class="' + (c[1] ? 'pass' : 'fail') + '">' + (c[1] ? 'PASS' : 'FAIL') + '</span> — ' + esc(c[0]) + '<small>' + esc(c[2]) + '</small></li>';
  }).join('');

  // ---- method
  var f = meta.fit;
  document.getElementById('method-body').innerHTML =
    '<p><strong>1. Launch value.</strong> A curve fitted on ' + f.nComps + ' cleaned traded comps (exchange, bridge and liquid-staking products dropped, wild multiples outside 0.005–5.0 dropped):</p>' +
    '<p><code>log10(mcap) = ' + f.curveA.toFixed(3) + ' + ' + f.curveB.toFixed(3) + ' &times; log10(TVL)</code> — so launch value &asymp; ' +
    (Math.pow(10, f.curveA)).toFixed(0) + ' &times; TVL<sup>' + f.curveB.toFixed(3) + '</sup>.</p>' +
    '<p><strong>2. Growth.</strong> The curve&rsquo;s residuals are regressed on the clipped 7-day TVL change with a robust (Huber) slope: intercept ' +
    f.c7Intercept.toFixed(3) + ', slope ' + f.c7Slope.toFixed(3) + '. A protocol growing fast is worth more than its TVL alone says.</p>' +
    (variant === 'A' ? '' :
    '<p><strong>3. Token odds.</strong> A logistic regression on the peer record (144 traded = 1, 614 pre-token = 0) over log TVL, 7-day change, log age, chain count and a shrunk category launch rate. ' +
    '5-fold cross-validated AUC ' + f.oddsAuc.toFixed(3) + ', log-loss ' + f.oddsLogloss.toFixed(3) + ' — weak but real signal: it separates the categories that do launch tokens from the ones that almost never do.</p>' +
    '<p><strong>4. Implied value = launch value &times; odds.</strong> That is the expected value of the launch. ' +
    'Age is deliberately not in the launch value: held-out tests show an age factor fitted on old protocols does not survive to young ones, so it only enters the odds, where its fitted weight is small.</p>') +
    '<p><strong>Verdicts.</strong> FARM at ' + (variant === 'A' ? 'launch value' : 'implied value') + ' &ge; ' + (variant === 'A' ? '$50M' : '$10M') + ', THIN at ' + (variant === 'A' ? '$10M–$50M' : '$2M–$10M') + ', SKIP below ' + (variant === 'A' ? '$10M' : '$2M') + '. ' +
    'The headline board is the ' + meta.nFarmable + ' farmable pre-token rows. The other ' + meta.nExcluded + ' pre-token rows are flagged as wrapped, staked, bridged, versioned or exchange products of a traded token — their fitted value is still in the board, but they are listed in their own section below, because ranking an exchange as the #1 farm would be wrong: its TVL is exchange reserves, not DeFi TVL, and the comps curve does not apply to it.</p>';

  // ---- walk-forward
  var wf = f.walkForward;
  document.getElementById('walk-body').innerHTML =
    '<p>Walk-forward: fit on the ' + wf.nFit + ' oldest dated comps, tested on the ' + wf.nTest + ' newest — ' +
    'median |log<sub>10</sub> error| <strong>' + wf.medianErr.toFixed(3) + '</strong>, i.e. the typical prediction is within a factor of <strong>&times;' + wf.factor.toFixed(2) + '</strong> of the real market cap.</p>' +
    '<p>Token odds, 5-fold cross-validated on the peer record: AUC <strong>' + f.oddsAuc.toFixed(3) + '</strong> (0.5 is a coin flip), log-loss <strong>' + f.oddsLogloss.toFixed(3) + '</strong>.</p>' +
    '<p>Read the errors as the point: a typical launch-value call is off by about a factor of two, and the odds only weakly separate launchers from never-launchers. The board ranks by expected value anyway, because ranking by TVL alone would be worse.</p>';

  // ---- board table
  var cats = [];
  pre.forEach(function (r) { if (cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  document.getElementById('fcat').innerHTML = '<option value="">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  var limit = 25;
  var selected = null;

  function filtered() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    var cat = document.getElementById('fcat').value;
    var st = document.getElementById('fstatus').value;
    var sort = document.getElementById('fsort').value;
    var list = farmable.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.category.toLowerCase().indexOf(q) < 0) return false;
      if (cat && r.category !== cat) return false;
      if (st === 'watchlist' && !r.wl) return false;
      if (st === 'farm' && r.verdict !== 'FARM') return false;
      if (st === 'thin' && r.verdict !== 'THIN') return false;
      if (st === 'skip' && r.verdict !== 'SKIP') return false;
      return true;
    });
    var key = { implied: 'implied', launch: 'launch', odds: 'odds', tvl: 'tvl', c7: 'c7' }[sort];
    list.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      return bv - av || (a.slug < b.slug ? -1 : 1);
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    var shown = list.slice(0, limit);
    var tbody = document.getElementById('rows');
    tbody.innerHTML = shown.map(function (r) {
      var range = (r.lo !== null && r.hi !== null) ? ' <span title="Rank range over 50 bootstrap refits">(' + r.lo + '&ndash;' + r.hi + ')</span>' : '';
      var oddsCell = variant === 'A' ? '' : '<td class="num">' + pct(r.odds) + '</td>';
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (selected === r.slug ? 'sel' : '') + '">' +
        '<td class="num">#' + r.farm + range + '</td>' +
        '<td class="name">' + esc(r.name) + (r.wl ? '<span class="badge wl">WATCHLIST</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category) + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td>' +
        '<td class="num">' + (r.c7 === null ? '—' : (r.c7 > 0 ? '+' : '') + r.c7.toFixed(1) + '%') + '</td>' +
        '<td class="num">' + (r.age === null ? '—' : r.age + 'd') + '</td>' +
        '<td class="num">' + money(r.launch) + '</td>' +
        oddsCell +
        '<td class="num"><strong>' + money(r.implied) + '</strong></td>' +
        '<td><span class="badge ' + r.verdict.toLowerCase() + '">' + r.verdict + '</span></td></tr>';
    }).join('');
    document.getElementById('count').textContent = 'Showing ' + shown.length + ' of ' + list.length + ' matching rows (' + farmable.length + ' farmable pre-token in total; ' + flagged.length + ' flagged products are listed separately below).';
    document.getElementById('more').disabled = list.length <= limit;
    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
    });
  }

  function showDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selected = slug;
    var sec = document.getElementById('detail');
    sec.hidden = false;
    var title = r.traded ? 'Already trading: ' + r.name
      : (r.flag ? '#' + r.pre + ' (flagged) — ' : '#' + r.farm + ' — ') + r.name;
    document.getElementById('detail-title').textContent = title;
    var range = (r.lo !== null && r.hi !== null)
      ? '<div><b>#' + r.lo + '–#' + r.hi + '</b><span>rank range over 50 bootstrap refits</span></div>' : '';
    var flag = r.flag ? '<p class="warn">Flagged: this looks like a ' + esc(r.flag) + ' — its value is ranked on the same curve, but a product of an already-traded token rarely launches its own.</p>' : '';
    var oddsKv = variant === 'A' ? '' : '<div><b>' + (r.traded ? '—' : pct(r.odds)) + '</b><span>fitted token odds</span></div>';
    document.getElementById('detail-body').innerHTML =
      '<div class="kv">' +
      '<div><b>' + moneyFull(r.traded ? (r.mcap !== null && r.mcap !== undefined ? r.mcap : r.implied) : r.implied) + '</b><span>' + (r.traded ? 'recorded market cap' : 'implied value (launch × odds)') + '</span></div>' +
      '<div><b>' + (r.traded ? '—' : moneyFull(r.launch)) + '</b><span>launch value from the comps curve</span></div>' +
      oddsKv +
      '<div><b>' + moneyFull(r.tvl) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.c7 === null ? '—' : (r.c7 > 0 ? '+' : '') + r.c7.toFixed(1) + '%') + '</b><span>TVL change, 7 days</span></div>' +
      '<div><b>' + (r.age === null ? '—' : r.age + ' days') + '</b><span>age since listing</span></div>' +
      '<div><b>' + chainsShort(r) + '</b><span>chains</span></div>' +
      '<div><b>' + (r.traded ? 'TRADED' : r.verdict) + '</b><span>verdict</span></div>' +
      '<div><b>~$' + r.cost + '</b><span>estimated cost of the plan</span></div>' +
      '</div>' + range + flag +
      '<h3>' + (r.traded ? 'What to do instead of farming' : 'Farm plan — estimated cost ~$' + r.cost) + '</h3>' +
      '<ol class="plan">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    renderBoard();
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('q').addEventListener('input', function () { limit = 25; renderBoard(); });
  document.getElementById('fcat').addEventListener('change', function () { limit = 25; renderBoard(); });
  document.getElementById('fstatus').addEventListener('change', function () { limit = 25; renderBoard(); });
  document.getElementById('fsort').addEventListener('change', function () { limit = 25; renderBoard(); });
  document.getElementById('more').addEventListener('click', function () { limit += 25; renderBoard(); });

  // ---- traded table
  var tSorted = traded.slice().sort(function (a, b) { return b.implied - a.implied; });
  document.getElementById('traded-rows').innerHTML = tSorted.map(function (r, i) {
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="num">#' + (i + 1) + '</td>' +
      '<td class="name">' + esc(r.name) + '</td>' +
      '<td>' + esc(r.category) + '</td>' +
      '<td class="num">' + money(r.tvl) + '</td>' +
      '<td class="num"><strong>' + money(r.mcap !== null && r.mcap !== undefined ? r.mcap : r.implied) + '</strong></td>' +
      '<td>' + chainsShort(r) + '</td></tr>';
  }).join('');
  document.querySelectorAll('#traded-rows tr').forEach(function (tr) {
    tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
  });

  // ---- flagged products (pre-token rows that are products of a traded token)
  var fSorted = flagged.slice().sort(function (a, b) { return b.implied - a.implied; });
  document.getElementById('flagged-rows').innerHTML = fSorted.map(function (r) {
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="num">#' + r.pre + '</td>' +
      '<td class="name">' + esc(r.name) + '</td>' +
      '<td>' + esc(r.category) + '</td>' +
      '<td>' + esc(r.flag) + '</td>' +
      '<td class="num">' + money(r.tvl) + '</td>' +
      '<td class="num">' + money(r.implied) + '</td>' +
      '<td><span class="badge ' + r.verdict.toLowerCase() + '">' + r.verdict + '</span></td></tr>';
  }).join('');
  document.querySelectorAll('#flagged-rows tr').forEach(function (tr) {
    tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
  });

  renderBoard();
})();
