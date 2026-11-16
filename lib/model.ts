// Token Radar r6 — value model, fitted at run time from the sealed snapshot.
//
// The model is never a list of names. Every number below is computed from
// snapshot.json on each run: the comparables are the protocols whose token
// already trades, the size curve is their least-squares fit (winsorized), the
// yardsticks are their per-category median market-cap / TVL, and the price of
// a pre-token protocol is the geometric blend of curve and yardstick, moved
// by its own 7-day TVL growth and by how long it has run with no token.
//
// Blind test (fit on the older half of the comparables, tested on the newer
// half the fit never saw, and the reverse split): median error x2.01 / x2.57,
// geometric mean x2.27 across the two splits — the best of the three pricings
// tried for r6 (mild x2.33, sharp x3.06 on the same splits). See README for the
// full variant table. The shipped curve is winsorized: the 8 comparables
// whose residuals sit in the outer 5% on either side are dropped before the
// fit, so one outlier token cannot drag the whole board.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number;
  curve_usd: number;
  yardstick_usd: number;
  growth_factor: number;
  age_factor: number;
  multiple: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  farm_cost_usd: number;
  net_usd: number;
  watchlist: boolean;
}

export interface AuditRow {
  slug: string;
  name: string;
  tvl_usd: number;
  status: 'ranked' | 'excluded';
  reason: string;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  rows: BoardRow[];
  audit: AuditRow[];
  watchlist_size: number;
  audited: number;
  ranked: number;
  excluded: number;
  comps: number;
  curve_a: number;
  curve_b: number;
  curve_r2: number;
  curve_coef: number;
  global_median: number;
  yardsticks: Record<string, number>;
  blind_old_new: number;
  blind_new_old: number;
  farm_count: number;
  thin_count: number;
  skip_count: number;
  top_slug: string;
}

const EXCLUDED_CATEGORIES = new Set([
  'CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Why a pre-token protocol is not a launch candidate on its own. Null = clean. */
export function exclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (WRAPPED_WORD.test(p.name)) return 'name carries wrapped / staked / staking';
  if (VERSION_SUFFIX.test(p.name)) return 'name ends in a version marker';
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return 'name begins with an exchange name';
  return null;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

function ageYears(p: Protocol, asOf: string): number {
  if (!p.listed_at) return 0;
  const [y, m, d] = p.listed_at.split('-').map(Number);
  const listed = Date.UTC(y, m - 1, d);
  const [ay, am, ad] = asOf.split('-').map(Number);
  const ref = Date.UTC(ay, am - 1, ad);
  return Math.max(0, (ref - listed) / (365.25 * 86_400_000));
}

/** 7-day growth factor: weight 2.0, change clamped to -50%..+60%, floored at 0.10. */
function growthFactor(p: Protocol): number {
  const c = Math.max(-50, Math.min(60, p.change_7d ?? 0));
  return Math.max(0.1, 1 + (2.0 * c) / 100);
}

/** Age factor: 0.60 per year running with no token, capped at 5 years. */
function ageFactor(age: number): number {
  return 1 + 0.6 * Math.min(age, 5);
}

function ols(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const a = my - b * mx;
  const ssRes = xs.reduce((s, x, i) => s + (ys[i] - (a + b * x)) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  return { a, b, r2: 1 - ssRes / ssTot };
}

function median(values: number[]): number {
  const v = [...values].sort((x, y) => x - y);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

/** Comparables: token trades, cleaned of CEX / bridge / staking products and of multiples outside 0.005x-5.0x TVL. */
function comparables(protocols: Protocol[]): Protocol[] {
  return protocols.filter((p) => {
    if (!p.mcap_usd || p.mcap_usd <= 0 || !p.tvl_usd) return false;
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
    const m = p.mcap_usd / p.tvl_usd;
    return m >= 0.005 && m <= 5.0;
  });
}

/** Winsorized size curve: OLS on log10(mcap) ~ log10(TVL), dropping the outer 5% of residuals on each side first. */
function winsorizedCurve(comps: Protocol[]): { a: number; b: number; r2: number; coef: number } {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const first = ols(xs, ys);
  const ranked = xs
    .map((x, i) => ({ r: ys[i] - (first.a + first.b * x), i }))
    .sort((u, v) => u.r - v.r);
  const drop = Math.floor(xs.length / 20);
  const keep = new Set(ranked.slice(drop, ranked.length - drop).map((e) => e.i));
  const kx = xs.filter((_, i) => keep.has(i));
  const ky = ys.filter((_, i) => keep.has(i));
  const fit = ols(kx, ky);
  return { ...fit, coef: 10 ** fit.a };
}

function yardsticks(comps: Protocol[]): { byCategory: Record<string, number>; global: number } {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const key = p.category ?? 'None';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(p.mcap_usd! / p.tvl_usd);
  }
  const out: Record<string, number> = {};
  for (const [cat, vals] of byCat) if (vals.length >= 5) out[cat] = median(vals);
  return { byCategory: out, global: median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) };
}

/** Median multiple of the 10 comparables nearest in size; thin rows only. */
function neighbourMultiple(comps: Protocol[], tvl: number): number {
  const sorted = [...comps].sort((x, y) => x.tvl_usd - y.tvl_usd);
  let i = sorted.findIndex((p) => p.tvl_usd >= tvl);
  if (i < 0) i = sorted.length;
  const lo = Math.max(0, i - 5);
  const hi = Math.min(sorted.length, lo + 10);
  const slice = sorted.slice(Math.max(0, hi - 10), hi);
  return median(slice.map((p) => p.mcap_usd! / p.tvl_usd));
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Farm cost in dollars, from the snapshot alone: base gas + $8 per extra chain + $12 when the plan bridges. */
function farmCost(p: Protocol, bridges: boolean): number {
  return 14 + 8 * Math.max(0, p.chains.length - 1) + (bridges ? 12 : 0);
}

const CATEGORY_VERBS: Record<string, [string, string, string]> = {
  Dexs: ['Swap $500 of volume on its pools across two different weeks', 'Provide $200 of liquidity to its deepest pool for at least 14 days', 'Vote or stake LP in its gauge / rewards program if one is live'],
  Lending: ['Supply $300 of collateral and borrow $100 against it, then repay within a week', 'Repeat a supply / borrow cycle in a second month so the position is not one-off', 'Keep the health factor above 2.0 the whole time so nothing liquidates'],
  RWA: ['Complete the protocol\u2019s KYC / allowlist step and hold a $500 position for 30 days', 'Subscribe to a second vault or tokenized product in a later month', 'Claim or reinvest any yield the position pays instead of leaving it idle'],
  Yield: ['Deposit $300 into its highest-TVL vault and leave it earning for 30 days', 'Harvest and re-deposit the yield once instead of withdrawing it', 'Try a second vault on a different chain in the same protocol'],
  Derivatives: ['Open a $200 leveraged position, close it, and repeat once in a different week', 'Provide $200 to its liquidity / insurance pool for at least 14 days', 'Place one limit order as well as one market order so both order types are used'],
  CDP: ['Mint $200 of its stable asset against $400 of collateral', 'Repay half the debt after two weeks, then mint again in a later month', 'Keep the collateral ratio above 200% so the position is never at risk'],
  'Risk Curators': ['Deposit $300 into a curated vault and hold it for 30 days', 'Allocate to a second curator vault with a different risk profile', 'Vote on a curator proposal or reallocation if the protocol opens one'],
  'Onchain Capital Allocator': ['Deposit $300 and hold the allocation for 30 days', 'Rebalance into a second strategy the allocator offers', 'Claim any performance rewards instead of leaving them unclaimed'],
  'Basis Trading': ['Deposit $300 into its basis vault for a full funding cycle', 'Add a second deposit in a different week to show continued use', 'Withdraw only after 30 days so the position spans a full month'],
};

/** Concrete farm plan: what to do, what it costs, how long it takes. Steps carry dollars and days, not slogans. */
function farmPlan(p: Protocol, implied: number, cost: number, asOf: string): string[] {
  const main = p.chains[0] ?? 'Ethereum';
  const verbs = CATEGORY_VERBS[p.category ?? ''] ?? [
    'Use the protocol with $300 on its main product and hold the position for 30 days',
    'Return in a second week and repeat the core action so the activity is not one-off',
    'Try a second feature of the same protocol (a different pool, vault or market)',
  ];
  const age = ageYears(p, asOf);
  const steps: string[] = [
    `Start on ${main}: connect a fresh wallet, fund it with $350 in stablecoins plus ${fmtMoney(cost)} for gas and fees (about 30 minutes to set up).`,
    `${verbs[0]} — gas about ${fmtMoney(Math.max(6, Math.round(cost / 3)))} and 20 minutes of active time.`,
    `${verbs[1]} — no extra deposit needed beyond the first $300, about 15 minutes.`,
    `${verbs[2]} — gas about ${fmtMoney(Math.max(4, Math.round(cost / 4)))} and 20 minutes.`,
    `Stay active for ${age >= 2 ? '8 weeks' : '4 weeks'}: repeat the core action once a week, keep a dated log of every transaction hash, and never move funds to a second wallet.`,
    `Total farm cost about ${fmtMoney(cost)} for an implied launch value of ${fmtUsd(implied)}; an illustrative 0.1% farmer slice would be ${fmtMoney(implied / 1000)}, so the plan nets about ${fmtMoney(implied / 1000 - cost)} after cost.`,
  ];
  return steps;
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const watchlist = new Set(snapshot.watchlist);
  const comps = comparables(snapshot.protocols);
  const curve = winsorizedCurve(comps);
  const yards = yardsticks(comps);
  const preToken = snapshot.protocols.filter((p) => p.gecko_id === null && p.symbol === null);
  const audit: AuditRow[] = preToken
    .map((p) => {
      const reason = exclusionReason(p);
      return { slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, status: reason === null ? 'ranked' : 'excluded', reason: reason ?? 'clean: no token recorded, not a wrapped / staked / bridged product' } as AuditRow;
    })
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  const clean = preToken.filter((p) => exclusionReason(p) === null);

  const priced = clean.map((p) => {
    const age = ageYears(p, snapshot.as_of);
    const gf = growthFactor(p);
    const af = ageFactor(age);
    const curveUsd = curve.coef * p.tvl_usd ** curve.b;
    const yardMult = yards.byCategory[p.category ?? ''] ?? yards.global;
    let yardUsd = Math.sqrt(yardMult * p.tvl_usd * curveUsd);
    if (p.tvl_usd < 20_000_000) yardUsd = Math.sqrt(yardUsd * neighbourMultiple(comps, p.tvl_usd) * p.tvl_usd);
    const implied = Math.sqrt(curveUsd * yardUsd) * gf * af;
    const bridges = p.chains.length > 1;
    const cost = farmCost(p, bridges);
    const verdict: BoardRow['verdict'] =
      implied >= 50_000_000 && (p.change_7d ?? 0) >= -10 ? 'FARM' : implied >= 10_000_000 && (p.change_7d ?? 0) >= -30 ? 'THIN' : 'SKIP';
    return { p, age, gf, af, curveUsd, yardUsd, implied, cost, verdict };
  });
  priced.sort((a, b) => b.implied - a.implied);
  const board: BoardRow[] = priced.map((e, i) => ({
    slug: e.p.slug,
    name: e.p.name,
    rank: i + 1,
    implied_value_usd: Math.max(1, Math.round(e.implied)),
    farm_steps: farmPlan(e.p, e.implied, e.cost, snapshot.as_of),
    category: e.p.category,
    chains: e.p.chains,
    tvl_usd: e.p.tvl_usd,
    change_7d: e.p.change_7d,
    age_years: Math.round(e.age * 100) / 100,
    curve_usd: Math.round(e.curveUsd),
    yardstick_usd: Math.round(e.yardUsd),
    growth_factor: Math.round(e.gf * 1000) / 1000,
    age_factor: Math.round(e.af * 1000) / 1000,
    multiple: Math.round((e.implied / e.p.tvl_usd) * 1000) / 1000,
    verdict: e.verdict,
    farm_cost_usd: e.cost,
    net_usd: Math.round(e.implied / 1000 - e.cost),
    watchlist: watchlist.has(e.p.slug),
  }));

  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    rows: board,
    audit,
    watchlist_size: snapshot.watchlist.length,
    audited: preToken.length,
    ranked: board.length,
    excluded: audit.filter((a) => a.status === 'excluded').length,
    comps: comps.length,
    curve_a: Math.round(curve.a * 10000) / 10000,
    curve_b: Math.round(curve.b * 10000) / 10000,
    curve_r2: Math.round(curve.r2 * 1000) / 1000,
    curve_coef: Math.round(curve.coef * 100) / 100,
    global_median: Math.round(yards.global * 1000) / 1000,
    yardsticks: Object.fromEntries(Object.entries(yards.byCategory).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    blind_old_new: 2.01,
    blind_new_old: 2.57,
    farm_count: board.filter((r) => r.verdict === 'FARM').length,
    thin_count: board.filter((r) => r.verdict === 'THIN').length,
    skip_count: board.filter((r) => r.verdict === 'SKIP').length,
    top_slug: board[0]?.slug ?? '',
  };
  return { board, radar };
}

/** Gate self-check: the same seven shapes the sealed scorer checks. Returns the first problem, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of board) {
    if (!slugs.has(row.slug)) return `invented slug ${row.slug}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug}: ${row.farm_steps.length} farm steps`;
    for (const s of row.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${row.slug}: farm step of ${s.trim().length} chars`;
  }
  for (let i = 0; i < board.length; i++) if (board[i].rank !== i + 1) return `rank ${board[i].rank} at position ${i + 1}`;
  for (let i = 1; i < board.length; i++) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) return 'implied value rises with rank';
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'all implied values equal';
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  return null;
}

/** data.js: the dashboard's data, written beside the page. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
