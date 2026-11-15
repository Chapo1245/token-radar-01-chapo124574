// Token Radar dashboard: renders window.TOKEN_RADAR (written by main.ts).
// Sortable, filterable board; click a row for the detail view and farm plan.
// URL params: ?q=, ?category=, ?chain=, ?watchlist=1, ?sort=, ?detail=<slug>.

(function () {
  var D = window.TOKEN_RADAR;
  if (!D) { document.body.innerHTML = '<p style="padding:20px">Data failed to load.</p>'; return; }
  var rows = D.rows;

  var $ = function (id) { return document.getElementById(id); };
  var fmt$ = function (n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  };
  var pct = function (v) {
    if (v === null || v === undefined) return '<span>—</span>';
    var c = v >= 0 ? 'up' : 'down';
    return '<span class="' + c + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  };

  // Meta header + formula line.
  $('meta').innerHTML = '<b>' + rows.length + '</b> launch candidates<br>' +
    '<b>' + D.counts.watchlist + '</b> on the watchlist · floor $50M<br>' +
    'snapshot ' + D.as_of + ' · ' + D.counts.protocols + ' protocols tracked';
  $('asof').textContent = D.as_of;
  $('formula').textContent = 'Growth compounds: exp(0.010 × the 7-day TVL change, clamped −50…+100), ' +
    'so a fast grower compounds upward and a shrinker decays. Maturity is 1 + 0.35 × years listed, ' +
    'capped at 5 years. TVL is dampened to the power 0.80 so size leads without burying smaller fast movers. ';

  // Fill filter selects from the data itself.
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort().forEach(function (c) { $('cat').appendChild(new Option(c, c)); });
  chains.sort().forEach(function (c) { $('chain').appendChild(new Option(c, c)); });

  var sortKey = 'rank';
  var sortFns = {
    rank: function (a, b) { return a.rank - b.rank; },
    tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
    growth: function (a, b) { return (b.change_7d === null ? -999 : b.change_7d) - (a.change_7d === null ? -999 : a.change_7d); },
    age: function (a, b) { return b.age_years - a.age_years; },
  };

  function visible() {
    var q = $('q').value.trim().toLowerCase();
    var cat = $('cat').value, chain = $('chain').value, watch = $('watch').checked;
    var list = rows.filter(function (r) {
      if (watch && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (chain && r.chains.indexOf(chain) < 0) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    return list.sort(sortFns[sortKey]);
  }

  function render() {
    var list = visible();
    $('count').textContent = list.length + ' of ' + rows.length + ' shown';
    $('rows').innerHTML = list.map(function (r) {
      return '<tr class="row" data-slug="' + r.slug + '">' +
        '<td>' + r.rank + '</td>' +
        '<td><b>' + r.name + '</b>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '<br><span style="color:var(--muted);font-size:12px">' + r.slug + '</span></td>' +
        '<td>' + (r.category || '—') + '</td>' +
        '<td>' + r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + fmt$(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + r.age_years.toFixed(1) + 'y</td>' +
        '<td class="num val">' + fmt$(r.implied_value_usd) + '</td></tr>';
    }).join('');
  }

  function showDetail(slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    document.querySelectorAll('tr.row').forEach(function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    var steps = r.farm_steps.map(function (s, i) {
      var c = s.indexOf(':');
      var body = c > 0 ? '<b>' + s.slice(0, c) + ':</b> ' + s.slice(c + 1).trim() : s;
      return '<li>' + body + '</li>';
    }).join('');
    $('detail').innerHTML =
      '<h2>' + r.name + '</h2>' +
      '<p class="sub">' + r.slug + ' · ' + (r.category || 'uncategorised') + ' · rank #' + r.rank +
      (r.watchlist ? ' · <span class="badge">WATCHLIST</span>' : '') + '</p>' +
      '<div class="big">' + fmt$(r.implied_value_usd) + ' <span style="font-size:14px;color:var(--muted)">implied value</span></div>' +
      '<div class="kv">' +
      '<div><span>TVL</span>' + fmt$(r.tvl_usd) + '</div>' +
      '<div><span>7-day change</span>' + (r.change_7d === null ? 'not reported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</div>' +
      '<div><span>Growth factor</span>×' + r.growth_factor.toFixed(3) + '</div>' +
      '<div><span>Maturity factor</span>×' + r.maturity_factor.toFixed(3) + ' (' + r.age_years.toFixed(1) + 'y listed)</div>' +
      '<div><span>Chains</span>' + r.chains.join(', ') + '</div>' +
      '<div><span>First listed</span>' + (r.listed_at || 'not reported') + '</div></div>' +
      '<p style="margin:0 0 4px"><b>How to farm it</b> <span style="color:var(--muted);font-size:12px">— records no token; 4–8 week plan</span></p>' +
      '<ol>' + steps + '</ol>';
  }

  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr.row');
    if (tr) showDetail(tr.getAttribute('data-slug'));
  });
  document.querySelectorAll('th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      sortKey = (k === 'value' || k === 'rank') ? 'rank' : k === 'tvl' ? 'tvl' : k === 'growth' ? 'growth' : k === 'age' ? 'age' : 'rank';
      $('sort').value = sortKey;
      render();
    });
  });
  ['q', 'cat', 'chain', 'watch', 'sort'].forEach(function (id) {
    $(id).addEventListener('input', function () { if (id === 'sort') sortKey = $('sort').value; render(); });
  });

  // Reference lists.
  $('launched').innerHTML = D.launched.map(function (p) {
    return '<li><b>' + p.name + '</b> <span>— ' + (p.symbol || '') + ' · ' + fmt$(p.mcap_usd) + ' market cap · ' + (p.category || '') + '</span></li>';
  }).join('');
  $('excluded').innerHTML = D.excluded_no_token.map(function (p) {
    return '<li><b>' + p.name + '</b> <span>— ' + fmt$(p.tvl_usd) + ' TVL · set aside: ' + p.reason + '</span></li>';
  }).join('');

  // URL params (used for the filtered / detail screenshots).
  var params = new URLSearchParams(location.search);
  if (params.get('q')) $('q').value = params.get('q');
  if (params.get('category')) $('cat').value = params.get('category');
  if (params.get('chain')) $('chain').value = params.get('chain');
  if (params.get('watchlist') === '1') $('watch').checked = true;
  if (params.get('sort')) { sortKey = params.get('sort'); $('sort').value = sortKey; }
  render();
  if (params.get('detail')) showDetail(params.get('detail'));
  else if (rows.length) showDetail(rows[0].slug);
})();
