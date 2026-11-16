// app.js — renders the Launch Radar board from window.TOKEN_RADAR (data.js).
// No network: every number on the page comes from the program's own run.

const DATA = window.TOKEN_RADAR || { rows: [] };
const rows = DATA.rows || [];

const $ = (id) => document.getElementById(id);
const money = (v) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The header numbers and the method panel, straight from the run. */
function renderStats() {
  $('stat-rows').textContent = String(rows.length);
  $('stat-farm').textContent = String(DATA.verdicts ? DATA.verdicts.FARM : 0);
  $('stat-thin').textContent = String(DATA.verdicts ? DATA.verdicts.THIN : 0);
  $('stat-skip').textContent = String(DATA.verdicts ? DATA.verdicts.SKIP : 0);
  $('stat-top').textContent = rows.length > 0 ? money(rows[0].implied_value_usd) : '—';
  if (DATA.model) $('formula').textContent = DATA.model;
  if (DATA.comps) {
    $('comps-n').textContent = String(DATA.comps.n);
    $('comps-r2').textContent = DATA.comps.r2.toFixed(3);
    $('comps-holdout').textContent = String(DATA.comps.holdout_n);
    $('comps-factor').textContent = DATA.comps.holdout_factor.toFixed(2);
  }
}

/** Category options, most protocols first, so the filter reads like the board. */
function renderCategories() {
  const counts = new Map();
  for (const r of rows) counts.set(r.category || 'Uncategorised', (counts.get(r.category || 'Uncategorised') || 0) + 1);
  const select = $('category');
  for (const [cat, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat} (${n})`;
    select.appendChild(opt);
  }
}

/** The rows the current filters leave, in the current sort order. */
function visibleRows() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('category').value;
  const verdict = $('verdict').value;
  const sort = $('sort').value;
  let out = rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))) return false;
    if (cat && (r.category || 'Uncategorised') !== cat) return false;
    if (verdict && r.verdict !== verdict) return false;
    return true;
  });
  const by = {
    value: (a, b) => b.implied_value_usd - a.implied_value_usd,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9),
    age: (a, b) => b.age_years - a.age_years,
    name: (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  };
  out = [...out].sort(by[sort] || by.value);
  return out;
}

function renderTable() {
  const list = visibleRows();
  const tbody = $('rows');
  tbody.innerHTML = '';
  for (const r of list) {
    const tr = document.createElement('tr');
    tr.dataset.slug = r.slug;
    if (selectedSlug === r.slug) tr.classList.add('selected');
    const growthClass = (r.change_7d ?? 0) >= 0 ? 'up' : 'down';
    tr.innerHTML =
      `<td class="num">${r.rank}</td>` +
      `<td class="name"><b>${esc(r.name)}</b><span>${esc(r.slug)}</span></td>` +
      `<td>${esc(r.category || '—')}</td>` +
      `<td class="num">${r.chains.length}</td>` +
      `<td class="num">${money(r.tvl_usd)}</td>` +
      `<td class="num growth ${growthClass}">${pct(r.change_7d)}</td>` +
      `<td class="num">${r.age_years.toFixed(1)}y</td>` +
      `<td class="num"><b>${money(r.implied_value_usd)}</b></td>` +
      `<td><span class="pill ${r.verdict.toLowerCase()}">${r.verdict}</span></td>`;
    tr.addEventListener('click', () => showDetail(r.slug));
    tbody.appendChild(tr);
  }
  $('empty').hidden = list.length > 0;
  $('count').textContent = `${list.length} of ${rows.length} protocols`;
}

let selectedSlug = null;

/** The detail panel for one protocol: its figures and its farm plan. */
function showDetail(slug) {
  const r = rows.find((row) => row.slug === slug);
  const panel = $('detail');
  if (!r) {
    panel.innerHTML = '<p class="detail-hint">Select a row to see its farm plan.</p>';
    selectedSlug = null;
    return;
  }
  selectedSlug = slug;
  for (const tr of document.querySelectorAll('#rows tr')) {
    tr.classList.toggle('selected', tr.dataset.slug === slug);
  }
  const steps = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  panel.innerHTML =
    `<h2>${esc(r.name)}</h2>` +
    `<p class="facts">` +
    `<span>Rank <b>#${r.rank}</b></span>` +
    `<span>Implied value <b>${money(r.implied_value_usd)}</b></span>` +
    `<span>TVL <b>${money(r.tvl_usd)}</b></span>` +
    `<span>7-day <b>${pct(r.change_7d)}</b></span>` +
    `<span>Age with no token <b>${r.age_years.toFixed(1)} years</b></span>` +
    `<span>Category <b>${esc(r.category || '—')}</b></span>` +
    `<span>Chains <b>${esc(r.chains.join(', '))}</b></span>` +
    `<span>Verdict <span class="pill ${r.verdict.toLowerCase()}">${r.verdict}</span></span>` +
    `</p>` +
    `<p>This protocol records no token. The implied value follows from the ` +
    `formula in the method section below: its TVL, its seven-day change and the ` +
    `years it has run with no token recorded.</p>` +
    `<h3>Farm plan — what to do, what it costs, how long it takes</h3>` +
    `<ol>${steps}</ol>`;
  if (history.replaceState) history.replaceState(null, '', `#${slug}`);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Deep links: #slug opens a detail, ?verdict= / ?category= pre-filter. */
function initFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('verdict')) $('verdict').value = params.get('verdict');
  if (params.get('category')) $('category').value = params.get('category');
  // The query values above change what the board shows, so render again
  // with them applied before opening any deep-linked detail.
  renderTable();
  if (location.hash.length > 1) showDetail(decodeURIComponent(location.hash.slice(1)));
}

for (const id of ['q', 'category', 'verdict', 'sort']) {
  $(id).addEventListener('input', renderTable);
  $(id).addEventListener('change', renderTable);
}
window.addEventListener('hashchange', () => {
  if (location.hash.length > 1) showDetail(decodeURIComponent(location.hash.slice(1)));
});

renderStats();
renderCategories();
renderTable();
initFromUrl();
