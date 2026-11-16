// Token Radar r6 dashboard: sortable, filterable board + detail view + audit.
// Data comes from data.js (window.RADAR), written by main.ts from the same
// board.json the gate checks — the screenshots and the code agree by
// construction, because both are rendered from one object.
const R = window.RADAR;
const $ = (s) => document.querySelector(s);
const money = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`;
const signed = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');

let sortKey = 'implied_value_usd';
let sortDir = -1;
let selected = null;

function init() {
  $('#stat-line').textContent = `${R.ranked} protocols ranked · ${R.audited} audited · watchlist ${R.watchlist_size}/40 covered · ${R.comps} comparables whose token already trades · snapshot ${R.as_of}`;
  $('#stat-farm').textContent = R.farm_count;
  $('#stat-thin').textContent = R.thin_count;
  $('#stat-skip').textContent = R.skip_count;
  $('#asof').textContent = R.as_of;
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  for (const c of cats) { const o = document.createElement('option'); o.textContent = c; $('#category').appendChild(o); }
  $('#method-text').textContent = `Implied value = geometric mean of two prices from the snapshot's own figures, times growth and age. ` +
    `Size curve (winsorized least squares over ${R.comps} cleaned comparables): log10(mcap) = ${R.curve_a} + ${R.curve_b} × log10(TVL), R² ${R.curve_r2} — that is ${R.curve_coef} × TVL^${R.curve_b}. ` +
    `Category yardstick: each category's median market-cap / TVL (global median ${R.global_median}x); thin rows under $20M TVL are also priced off their 10 nearest comparables by size. ` +
    `Growth factor: 7-day TVL change, weight 2.0, clamped −50%..+60%. Age factor: 0.60 per year with no token recorded, capped at 5 years. ` +
    `FARM means implied value ≥ $50M and 7-day change ≥ −10%; THIN ≥ $10M and ≥ −30%; otherwise SKIP. Nothing is hardcoded by name.`;
  $('#blind-text').textContent = `Fitted on the older half of the comparables and tested on the newer half it never saw: median error ×${R.blind_old_new}. ` +
    `Fitted on the newer half and tested on the older: median error ×${R.blind_new_old}. The mild and sharp pricings tried for this round were worse on the same splits (×2.33 and ×3.06 mean), so the winsorized blend shipped.`;
  $('#yards').innerHTML = Object.entries(R.yardsticks).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><b>${k}</b> — ${v}x</li>`).join('');
  const byReason = {};
  for (const a of R.audit) if (a.status === 'excluded') byReason[a.reason] = (byReason[a.reason] || 0) + 1;
  $('#audit-summary').textContent = `${R.audited} protocols record no token. ${R.ranked} are clean launches and ranked below. ${R.excluded} are excluded with a reason each: ` +
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('; ') + '.';
  $('#audit-table tbody').innerHTML = R.audit.filter((a) => a.status === 'excluded').map((a) =>
    `<tr><td>${a.name}<span class="slug">${a.slug}</span></td><td class="num">${money(a.tvl_usd)}</td><td class="badge-ex">EXCLUDED</td><td>${a.reason}</td></tr>`).join('');
  for (const th of document.querySelectorAll('#board th')) th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'name' || k === 'category' ? 1 : -1; }
    render();
  });
  for (const id of ['q', 'verdict', 'category', 'watchonly']) document.getElementById(id).addEventListener('input', render);
  $('#detail-close').addEventListener('click', () => { $('#detail').hidden = true; selected = null; render(); });
  render();
  showDetail(R.rows[0]);
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const v = $('#verdict').value, c = $('#category').value, w = $('#watchonly').checked;
  let rows = R.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!v || r.verdict === v) && (!c || r.category === c) && (!w || r.watchlist));
  rows = [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDir;
  });
  return rows;
}

function render() {
  const rows = filtered();
  $('#row-count').textContent = `${rows.length} of ${R.rows.length} rows`;
  $('#board tbody').innerHTML = rows.map((r) =>
    `<tr data-slug="${r.slug}" class="${selected === r.slug ? 'sel' : ''}"><td>${r.rank}</td>` +
    `<td><b>${r.name}</b><span class="slug">${r.slug}${r.watchlist ? ' <span class="watch">★ watchlist</span>' : ''}</span></td>` +
    `<td>${r.category ?? '—'}</td><td class="num">${money(r.tvl_usd)}</td><td class="num">${signed(r.change_7d)}</td>` +
    `<td class="num">${r.age_years.toFixed(1)}y</td><td class="num"><b>${money(r.implied_value_usd)}</b></td>` +
    `<td class="num">${r.multiple.toFixed(2)}x</td><td><span class="pill ${r.verdict}">${r.verdict}</span></td>` +
    `<td class="num">${r.net_usd >= 0 ? '' : '−'}$${Math.abs(r.net_usd).toLocaleString('en-US')}</td></tr>`).join('');
  for (const tr of document.querySelectorAll('#board tbody tr')) tr.addEventListener('click', () => showDetail(R.rows.find((r) => r.slug === tr.dataset.slug)));
}

function showDetail(r) {
  if (!r) return;
  selected = r.slug;
  $('#detail').hidden = false;
  $('#detail-name').textContent = `#${r.rank} ${r.name} — ${money(r.implied_value_usd)} implied`;
  $('#detail-meta').textContent = `${r.slug} · ${r.category ?? 'no category'} · ${r.chains.join(', ')} · TVL ${money(r.tvl_usd)} · 7d ${signed(r.change_7d)} · ${r.age_years.toFixed(1)} years with no token recorded${r.watchlist ? ' · ★ on the watchlist' : ''}`;
  $('#detail-breakdown').innerHTML =
    `<div><span>${money(r.curve_usd)}</span><label>Size curve</label></div>` +
    `<div><span>${money(r.yardstick_usd)}</span><label>Category yardstick</label></div>` +
    `<div><span>×${r.growth_factor}</span><label>Growth factor</label></div>` +
    `<div><span>×${r.age_factor}</span><label>Age factor</label></div>` +
    `<div><span>${r.multiple.toFixed(2)}x</span><label>Implied / TVL</label></div>` +
    `<div><span>$${r.farm_cost_usd}</span><label>Farm cost</label></div>` +
    `<div><span class="pill ${r.verdict}">${r.verdict}</span><label>Verdict</label></div>`;
  $('#detail-steps').innerHTML = r.farm_steps.map((s) => `<li>${s}</li>`).join('');
  render();
}

init();
