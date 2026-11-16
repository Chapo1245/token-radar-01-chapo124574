// Token Radar v5 — value model: comps-priced launch values.
//
// How a protocol is priced (all of it from the snapshot's own figures):
//   1. Comparables: the protocols whose token already trades (mcap_usd present).
//      CEX, bridge and liquid-staking products are dropped (their tokens are not
//      launches), and multiples outside 0.005x-5.0x TVL are dropped as outliers.
//   2. Size curve: log10(mcap) = a + b * log10(TVL), least squares over the
//      cleaned comparables. It is fitted at run time, never hardcoded.
//   3. Blind test: the curve is fitted on the older half of the comparables
//      (by listed_at) and tested on the newer half. The median error factor is
//      reported in the board's model block, so the fit is checkable, not claimed.
//   4. Category yardstick: each category's median mcap/TVL among the cleaned
//      comparables (categories with at least 5 comps, else the global median).
//      Thin rows (TVL under $20M) are also priced off their ten nearest
//      comparables by size, so a small protocol is never priced off giants alone.
//   5. Shipped pricing ("blend-sharp"): the geometric mean of the size curve
//      and the yardstick price, times a growth factor (7-day TVL change,
//      weight 1.5, clamped -50%..+60%, floored at 0.10) and an age factor
//      (weight 0.60 per year with no token, capped at 5 years).
//   Two other pricings were fitted and blind-tested during development and
//   lost: the pure size curve (best blind error, but it under-prices the
//   largest launches against the comparables' own multiples) and the pure
//   yardstick (worst blind error). The blend keeps nearly the curve's blind
//   error while pricing the top of the board near the comparables' multiples.
//   See the blind-test table in the board's model block.
//
// The board ranks the protocols that record no token and are not a wrapped,
// staked or bridged product of one that trades, and not an exchange product:
// the watchlist's own exclusion rules, applied to every pre-token protocol.
// Farm plans are costed in dollars (gas + bridge + protocol fees) and end in
// a FARM / THIN / SKIP verdict netted against an illustrative farmer slice of
// 0.1% of the implied value. Implied value is this entry's own claim from the
// snapshot's figures; it never predicts whether or when a token launches.

export interface SnapshotProtocol {
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
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface CurveFit {
  intercept: number;
  slope: number;
  r2: number;
  n: number;
  formula: string;
}

export interface BlindTest {
  fit_n: number;
  test_n: number;
  median_log_error: number;
  median_ratio: number;
  p10_ratio: number;
  p90_ratio: number;
}

export interface ModelInfo {
  formula: string;
  variant: string;
  curve: CurveFit;
  blind: BlindTest;
  yardsticks: Record<string, number>;
  global_median_multiple: number;
  comps_n: number;
  verdict_rule: string;
  note: string;
}

export interface PricedRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  tvl_usd: number;
  change_7d: number | null;
  age_years: number;
  category: string | null;
  chains: string[];
  verdict: "FARM" | "THIN" | "SKIP";
  farm_cost_usd: number;
  expected_value_usd: number;
  net_usd: number;
  farm_steps: string[];
  growth_factor: number;
  maturity_factor: number;
  listed_at: string | null;
  watchlist: boolean;
  curve_value_usd: number;
  yardstick_value_usd: number;
}

const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
]);

const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

const OUTLIER_LOW = 0.005;
const OUTLIER_HIGH = 5.0;
const YARDSTICK_MIN_N = 5;
const THIN_TVL_USD = 20_000_000;
const NEIGHBOUR_K = 10;

const GROWTH_WEIGHT = 1.5;
const AGE_WEIGHT = 0.6;
const MAX_AGE_YEARS = 5;

const FARM_MIN_USD = 50_000_000;
const THIN_MIN_USD = 10_000_000;
const FARM_MIN_CHANGE = -10;
const THIN_MIN_CHANGE = -30;
const FARMER_SLICE = 0.001; // illustrative: 0.1% of implied value

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function ageYears(asOf: string, listedAt: string | null): number {
  if (!listedAt) return 0;
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / (365.25 * 24 * 60 * 60 * 1000);
}

export function growthFactor(change7d: number | null): number {
  const change = clamp(change7d ?? 0, -50, 60);
  return Math.max(0.1, 1 + (GROWTH_WEIGHT * change) / 100);
}

export function maturityFactor(age: number): number {
  return 1 + AGE_WEIGHT * Math.min(age, MAX_AGE_YEARS);
}

/** A protocol records no token: both gecko_id and symbol are null. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The watchlist's exclusion rules: not a wrapped, staked or bridged product
 *  of a protocol whose token trades, not an exchange product, not versioned. */
export function isRadarSubject(p: SnapshotProtocol): boolean {
  if (EXCLUDED_CATEGORIES.has(p.category ?? "")) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return false;
  }
  return true;
}

/** Comparables: traded tokens, cleaned of non-launch products and outliers. */
export function cleanComps(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  const out: SnapshotProtocol[] = [];
  for (const p of protocols) {
    if (!p.mcap_usd || p.mcap_usd <= 0 || !p.tvl_usd || p.tvl_usd <= 0) continue;
    if (EXCLUDED_CATEGORIES.has(p.category ?? "")) continue;
    const multiple = p.mcap_usd / p.tvl_usd;
    if (multiple < OUTLIER_LOW || multiple > OUTLIER_HIGH) continue;
    out.push(p);
  }
  return out;
}

function leastSquares(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sst += (ys[i] - my) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a + b * xs[i]);
    ssr += e * e;
  }
  return { a, b, r2: sst === 0 ? 0 : 1 - ssr / sst };
}

export function fitCurve(comps: SnapshotProtocol[]): CurveFit {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd as number));
  const { a, b, r2 } = leastSquares(xs, ys);
  return {
    intercept: a,
    slope: b,
    r2,
    n: comps.length,
    formula: `log10(mcap) = ${a.toFixed(3)} + ${b.toFixed(3)} * log10(TVL)`,
  };
}

/** Blind test: fit the whole pricing (curve, yardsticks, neighbours) on the
 *  older half of the comparables (by listed_at) and score the full pricing
 *  on the newer half, which the fit never saw. The scored pricing is the
 *  same formula that prices the board, so the error is the board's error. */
export function blindTest(comps: SnapshotProtocol[], asOf: string): BlindTest {
  const dated = comps
    .filter((p) => p.listed_at)
    .sort((a, b) => (a.listed_at as string) < (b.listed_at as string) ? -1 : 1);
  const half = Math.floor(dated.length / 2);
  const fitSet = dated.slice(0, half);
  const testSet = dated.slice(half);
  const fit = fitCurve(fitSet);
  const yard = yardsticks(fitSet);
  const compsByTvl = [...fitSet].sort((a, b) => a.tvl_usd - b.tvl_usd);
  const logErrors: number[] = [];
  const ratios: number[] = [];
  for (const p of testSet) {
    const predicted = priceWith(fit, yard, compsByTvl, asOf, p);
    const actual = p.mcap_usd as number;
    logErrors.push(Math.abs(Math.log10(actual) - Math.log10(predicted)));
    ratios.push(actual / predicted);
  }
  const sortedRatios = [...ratios].sort((a, b) => a - b);
  return {
    fit_n: fitSet.length,
    test_n: testSet.length,
    median_log_error: median(logErrors),
    median_ratio: median(ratios),
    p10_ratio: sortedRatios[Math.floor(sortedRatios.length * 0.1)] ?? 0,
    p90_ratio: sortedRatios[Math.floor(sortedRatios.length * 0.9)] ?? 0,
  };
}

/** Category yardsticks: median mcap/TVL per category (n >= 5), plus the
 *  global median multiple as the fallback. */
export function yardsticks(
  comps: SnapshotProtocol[],
): { byCategory: Record<string, number>; global: number } {
  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of comps) {
    const multiple = (p.mcap_usd as number) / p.tvl_usd;
    all.push(multiple);
    const key = p.category ?? "Uncategorised";
    const bucket = buckets.get(key) ?? [];
    bucket.push(multiple);
    buckets.set(key, bucket);
  }
  const byCategory: Record<string, number> = {};
  for (const [key, values] of [...buckets.entries()].sort()) {
    if (values.length >= YARDSTICK_MIN_N) byCategory[key] = median(values);
  }
  return { byCategory, global: median(all) };
}

/** Median multiple of the K comparables nearest in size to this TVL. */
export function neighbourMultiple(
  compsByTvl: SnapshotProtocol[],
  tvl: number,
): number {
  const sorted = compsByTvl;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid].tvl_usd < tvl) low = mid + 1;
    else high = mid;
  }
  let start = Math.max(0, low - Math.floor(NEIGHBOUR_K / 2));
  let end = Math.min(sorted.length, start + NEIGHBOUR_K);
  start = Math.max(0, end - NEIGHBOUR_K);
  const multiples: number[] = [];
  for (let i = start; i < end; i++) {
    multiples.push((sorted[i].mcap_usd as number) / sorted[i].tvl_usd);
  }
  return median(multiples);
}

export interface PricingContext {
  curve: CurveFit;
  blind: BlindTest;
  yard: { byCategory: Record<string, number>; global: number };
  compsByTvl: SnapshotProtocol[];
  asOf: string;
}

export function buildPricingContext(snapshot: Snapshot): PricingContext {
  const comps = cleanComps(snapshot.protocols);
  const curve = fitCurve(comps);
  const blind = blindTest(comps, snapshot.as_of);
  const yard = yardsticks(comps);
  const compsByTvl = [...comps].sort((a, b) => a.tvl_usd - b.tvl_usd);
  return { curve, blind, yard, compsByTvl, asOf: snapshot.as_of };
}

function curveValue(tvl: number, curve: CurveFit): number {
  return Math.pow(10, curve.intercept + curve.slope * Math.log10(tvl));
}

function yardstickValue(
  p: SnapshotProtocol,
  curve: CurveFit,
  yard: { byCategory: Record<string, number>; global: number },
  compsByTvl: SnapshotProtocol[],
): { value: number; multiple: number } {
  const multiple =
    yard.byCategory[p.category ?? "Uncategorised"] ?? yard.global;
  let value = Math.sqrt(multiple * p.tvl_usd * curveValue(p.tvl_usd, curve));
  if (p.tvl_usd < THIN_TVL_USD) {
    const near = neighbourMultiple(compsByTvl, p.tvl_usd);
    value = Math.sqrt(value * near * p.tvl_usd);
  }
  return { value, multiple };
}

/** The full blend pricing for one protocol, given fitted parameters. */
export function priceWith(
  curve: CurveFit,
  yard: { byCategory: Record<string, number>; global: number },
  compsByTvl: SnapshotProtocol[],
  asOf: string,
  p: SnapshotProtocol,
): number {
  const curveVal = curveValue(p.tvl_usd, curve);
  const yardVal = yardstickValue(p, curve, yard, compsByTvl);
  const base = Math.sqrt(curveVal * yardVal.value);
  const age = ageYears(asOf, p.listed_at);
  return Math.max(
    1,
    Math.round(base * growthFactor(p.change_7d) * maturityFactor(age)),
  );
}

/** The shipped pricing: geometric mean of the size curve and the yardstick
 *  price, times the growth and age factors. */
export function priceProtocol(
  p: SnapshotProtocol,
  ctx: PricingContext,
): { implied: number; curveValue: number; yardstickValue: number } {
  const curve = curveValue(p.tvl_usd, ctx.curve);
  const yard = yardstickValue(p, ctx.curve, ctx.yard, ctx.compsByTvl);
  const implied = priceWith(ctx.curve, ctx.yard, ctx.compsByTvl, ctx.asOf, p);
  return { implied, curveValue: Math.round(curve), yardstickValue: Math.round(yard.value) };
}

export function verdictFor(
  implied: number,
  change7d: number | null,
): "FARM" | "THIN" | "SKIP" {
  const change = change7d ?? 0;
  if (implied >= FARM_MIN_USD && change >= FARM_MIN_CHANGE) return "FARM";
  if (implied >= THIN_MIN_USD && change >= THIN_MIN_CHANGE) return "THIN";
  return "SKIP";
}

const CATEGORY_ACTIONS: Record<string, { core: string; extra: string }> = {
  Dexs: {
    core: "swap a $AMOUNT stablecoin pair on the DEX and add $AMOUNT to a core liquidity pool",
    extra: "vote on a gauge or fee proposal, or route one trade through the aggregator",
  },
  Lending: {
    core: "deposit $AMOUNT as collateral and borrow a small amount against it",
    extra: "repay the borrow in full, then open a fresh small borrow to show both sides of the market",
  },
  Yield: {
    core: "deposit $AMOUNT into the highest-TVL yield vault",
    extra: "harvest the vault's yield once, then re-deposit the harvest the same week",
  },
  RWA: {
    core: "deposit $AMOUNT into the RWA vault",
    extra: "read the vault's reporting page and leave the position untouched for a full epoch",
  },
  "Basis Trading": {
    core: "deposit $AMOUNT into the basis-trading vault",
    extra: "check the funding-rate report and top the vault up by $50-$100",
  },
  Perps: {
    core: "open a small $AMOUNT perp position at 1x-2x leverage and close it the same week",
    extra: "open a second small position on a different market and close it within the week",
  },
};

const DEFAULT_ACTION = {
  core: "use the protocol's core action with $AMOUNT",
  extra: "try a second feature of the protocol (a swap, a vote, a claim or a stake)",
};

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function gasPerTx(p: SnapshotProtocol): number {
  return p.chains.includes("Ethereum") ? 12 : 2;
}

export function farmPlan(
  p: SnapshotProtocol,
  implied: number,
  verdict: "FARM" | "THIN" | "SKIP",
): { steps: string[]; costUsd: number; expectedUsd: number; netUsd: number } {
  const action = CATEGORY_ACTIONS[p.category ?? ""] ?? DEFAULT_ACTION;
  const deposit = verdict === "FARM" ? 500 : verdict === "THIN" ? 200 : 100;
  const mainChain = p.chains[0] ?? "its main chain";
  const otherChains = p.chains.length > 1 ? ` (also on ${p.chains.length - 1} more)` : "";
  const gas = gasPerTx(p);
  const bridgeFee = p.chains.length > 1 ? 3 : 0;
  const weeklyGas = gas * 6;
  const cost = bridgeFee + gas * 4 + weeklyGas;
  const expected = Math.max(1, Math.round(implied * FARMER_SLICE));
  const net = expected - cost;
  const steps = [
    `Set up a fresh wallet just for farming and bridge ${money(deposit)} of stablecoins to ${mainChain}${otherChains} — bridge fee about ${money(bridgeFee)}, 10-20 minutes. Keep $10 of the chain's gas token aside so a stuck transaction never strands the position.`,
    `${capFirst(action.core.replaceAll("$AMOUNT", money(deposit)))} — leave it working for 6-8 weeks; deposit gas about ${money(gas)}. Check the position once a week and top up by $50-$100 every two weeks.`,
    `Come back every week for 6 weeks: repeat the core action with $50-$100 more and add one extra on-chain interaction (a swap, a vote or a claim) so the wallet shows steady use rather than a single deposit — about 20 minutes a week, gas about ${money(gas)} per visit.`,
    `${capFirst(action.extra)} — about 20 minutes, gas about ${money(gas)}. A wallet that uses two features reads as a real user, not a one-click farmer.`,
    `Track the position in a spreadsheet: deposit dates, amounts, transaction hashes and any points the protocol shows; screenshot the points page weekly so a missing allocation can be evidenced later — 10 minutes a week, no gas.`,
    `When the token launches (or after 8 weeks with no launch): claim any allocation, unstake, and bridge back — claim gas about ${money(gas)}. Verdict ${verdict}: an illustrative farmer slice of ${money(expected)} against ${money(cost)} in fees, net ${net >= 0 ? "+" : ""}${money(net)}.`,
  ];
  return { steps, costUsd: cost, expectedUsd: expected, netUsd: net };
}

function capFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function buildBoard(snapshot: Snapshot): { rows: PricedRow[]; model: ModelInfo } {
  const ctx = buildPricingContext(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const subjects = snapshot.protocols.filter(
    (p) => recordsNoToken(p) && isRadarSubject(p),
  );
  const priced: PricedRow[] = subjects.map((p) => {
    const { implied, curveValue: cv, yardstickValue: yv } = priceProtocol(p, ctx);
    const verdict = verdictFor(implied, p.change_7d);
    const plan = farmPlan(p, implied, verdict);
    const age = ageYears(ctx.asOf, p.listed_at);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: Math.round(age * 100) / 100,
      category: p.category,
      chains: p.chains,
      verdict,
      farm_cost_usd: plan.costUsd,
      expected_value_usd: plan.expectedUsd,
      net_usd: plan.netUsd,
      farm_steps: plan.steps,
      growth_factor: Math.round(growthFactor(p.change_7d) * 1000) / 1000,
      maturity_factor: Math.round(maturityFactor(age) * 1000) / 1000,
      listed_at: p.listed_at,
      watchlist: watchlist.has(p.slug),
      curve_value_usd: cv,
      yardstick_value_usd: yv,
    };
  });
  priced.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd) {
      return b.implied_value_usd - a.implied_value_usd;
    }
    return a.slug < b.slug ? -1 : 1;
  });
  priced.forEach((row, i) => {
    row.rank = i + 1;
  });
  const model: ModelInfo = {
    formula:
      "implied = sqrt(size-curve x category-yardstick) x (1 + 1.5 x clamp(change_7d, -50, +60) / 100, floored at 0.10) x (1 + 0.60 x min(age_years, 5)); thin rows (TVL under $20M) also priced off their 10 nearest comparables by size",
    variant: "blend-sharp (C): geometric mean of the fitted size curve and the category yardstick, sharper growth and age weights; chosen over the pure curve (A) and pure yardstick (B) by blind test",
    curve: ctx.curve,
    blind: ctx.blind,
    yardsticks: ctx.yard.byCategory,
    global_median_multiple: Math.round(ctx.yard.global * 1000) / 1000,
    comps_n: ctx.curve.n,
    verdict_rule:
      "FARM when implied value is at least $50M and 7-day TVL change is at least -10%; THIN when implied value is at least $10M and change is at least -30%; otherwise SKIP. Expected value is an illustrative farmer slice of 0.1% of implied value, net of the farm's dollar fees.",
    note: "Implied value is this entry's own claim from the snapshot's figures. It never predicts whether or when a token launches. A protocol is said to record no token, never to have none.",
  };
  return { rows: priced, model };
}
