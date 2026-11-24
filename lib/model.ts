// Token Radar v7 — the model: one snapshot in, one ranked board out.
//
// Everything is fitted from the snapshot's own figures at run time; no
// protocol name is ever special-cased and no number is carried in by hand.
//
//   launch value  log10(launch) = a + b*log10(TVL) + c*growth
//                 fitted by Huber robust regression (delta 1.5) on the
//                 traded comps: protocols whose token already trades,
//                 outside CEX / bridge / liquid-staking, with a market
//                 cap between 0.5% and 500% of TVL. 85 comps on this
//                 snapshot. Growth is the 7-day TVL change in percent,
//                 clipped to [-60, 120] and divided by 100.
//   token odds    P(records a token one day), a logistic regression on
//                 the whole peer record (144 traded = 1, 614 pre-token
//                 = 0) over log TVL, growth, log age, log chain count
//                 and a shrunk (k = 20) category launch rate.
//   implied       launch value x token odds, rounded to whole dollars.
//                 The board ranks the 340 farmable pre-token protocols
//                 by it. The 274 wrapped / staked / bridged / versioned
//                 / exchange products and the 144 traded protocols are
//                 counted in the same audit but kept in their own
//                 sections, never ranked as farms.

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
  tvlSlope: number;
  growthSlope: number;
  comps: number;
  residMedianAbs: number;
}

export interface OddsFit {
  intercept: number;
  coefLogTvl: number;
  coefGrowth: number;
  coefLogAge: number;
  coefLogChains: number;
  coefCatRate: number;
  auc: number;
  logLoss: number;
  cvAuc: number;
  cvLogLoss: number;
  globalRate: number;
}

export interface Validation {
  blindMedian: number;
  blindN: number;
  fourWayAge: number;
  fourWayRandom: number;
  looMedian: number;
  looN: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  launch_value_usd: number;
  token_odds: number | null;
  implied_value_usd: number;
  verdict: string;
  rank_lo: number;
  rank_hi: number;
  farm_steps: string[];
}

export interface SideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  age_days: number | null;
  fitted_value_usd: number | null;
  reason: string;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  variant: string;
  curve: CurveFit;
  odds: OddsFit;
  validation: Validation;
  counts: { scanned: number; farmable: number; flagged: number; traded: number; watchlist: number };
  watchlist: string[];
  verdicts: { farm: number; thin: number; skip: number };
  rows: BoardRow[];
  flagged: SideRow[];
  traded: SideRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-7';
export const FARM_VERDICT = 5_000_000;
export const THIN_VERDICT = 500_000;

const DAY_MS = 86_400_000;
const DROP_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function log10(n: number): number {
  return Math.log(n) / Math.LN10;
}

/** Days from `listedAt` to the snapshot date; null when unlisted or unparsable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The 7-day TVL change as a clipped fraction: null becomes 0, [-60, 120] percent. */
export function growthFraction(p: SnapshotProtocol): number {
  const g = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  return Math.min(120, Math.max(-60, g)) / 100;
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    const diag = a[col]![col]!;
    if (diag === 0) throw new SnapshotError('singular fit matrix');
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / diag;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * x[c]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

/** Ordinary least squares for a design matrix X (rows) and target y. */
function ols(xRows: number[][], y: number[]): number[] {
  const k = xRows[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const atb = new Array<number>(k).fill(0);
  for (let i = 0; i < xRows.length; i++) {
    const row = xRows[i]!;
    for (let c = 0; c < k; c++) {
      atb[c]! += row[c]! * y[i]!;
      for (let d = 0; d < k; d++) ata[c]![d]! += row[c]! * row[d]!;
    }
  }
  return solveLinear(ata, atb);
}

/** Weighted least squares with per-row weights. */
function wls(xRows: number[][], y: number[], w: number[]): number[] {
  const k = xRows[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const atb = new Array<number>(k).fill(0);
  for (let i = 0; i < xRows.length; i++) {
    const row = xRows[i]!;
    const wi = w[i]!;
    for (let c = 0; c < k; c++) {
      atb[c]! += wi * row[c]! * y[i]!;
      for (let d = 0; d < k; d++) ata[c]![d]! += wi * row[c]! * row[d]!;
    }
  }
  return solveLinear(ata, atb);
}

/**
 * Huber robust regression (delta 1.5, up to 80 IRLS rounds, scale
 * 1.4826 x MAD of the residuals). Starts at OLS and stops when the
 * largest coefficient move falls under 1e-9.
 */
export function huberFit(xRows: number[][], y: number[], delta = 1.5): number[] {
  let beta = ols(xRows, y);
  for (let round = 0; round < 80; round++) {
    const resid = xRows.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const med = median(resid);
    const scale = 1.4826 * median(resid.map((r) => Math.abs(r - med))) + 1e-9;
    const w = resid.map((r) => {
      const u = Math.abs(r / (delta * scale));
      return u <= 1 ? 1 : 1 / u;
    });
    const next = wls(xRows, y, w);
    const move = Math.max(...next.map((v, j) => Math.abs(v - beta[j]!)));
    beta = next;
    if (move < 1e-9) break;
  }
  return beta;
}

/** A traded protocol records a token with a positive market cap. */
export function isTraded(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

/** A protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The comps set: traded, not a dropped category, market cap 0.5%-500% of TVL. */
export function compsOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => {
    if (!isTraded(p)) return false;
    if (p.category !== null && DROP_CATEGORIES.has(p.category)) return false;
    const ratio = p.mcap_usd! / p.tvl_usd;
    return ratio >= 0.005 && ratio <= 5.0;
  });
}

function curveRow(p: SnapshotProtocol): number[] {
  return [1, log10(p.tvl_usd), growthFraction(p)];
}

function curvePredict(beta: number[], p: SnapshotProtocol): number {
  const row = curveRow(p);
  return row[0]! * beta[0]! + row[1]! * beta[1]! + row[2]! * beta[2]!;
}

export function fitCurve(comps: SnapshotProtocol[]): CurveFit {
  const x = comps.map(curveRow);
  const y = comps.map((p) => log10(p.mcap_usd!));
  const beta = huberFit(x, y, 1.5);
  const resid = comps.map((p, i) => Math.abs(y[i]! - curvePredict(beta, p)));
  return { intercept: beta[0]!, tvlSlope: beta[1]!, growthSlope: beta[2]!, comps: comps.length, residMedianAbs: median(resid) };
}

export function launchValue(fit: CurveFit, p: SnapshotProtocol): number {
  return Math.pow(10, fit.intercept + fit.tvlSlope * log10(p.tvl_usd) + fit.growthSlope * growthFraction(p));
}

/** A mulberry32 generator: deterministic, so two runs refit identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- token odds

function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

export function fitOdds(snapshot: Snapshot): OddsFit {
  const cats = new Map<string, { traded: number; total: number }>();
  let tradedTotal = 0;
  for (const p of snapshot.protocols) {
    const c = p.category ?? 'Other';
    const e = cats.get(c) ?? { traded: 0, total: 0 };
    e.total += 1;
    if (p.mcap_usd !== null) e.traded += 1;
    cats.set(c, e);
    if (p.mcap_usd !== null) tradedTotal += 1;
  }
  const globalRate = tradedTotal / snapshot.protocols.length;
  const catRate = (p: SnapshotProtocol): number => {
    const e = cats.get(p.category ?? 'Other')!;
    return (e.traded + 20 * globalRate) / (e.total + 20);
  };
  const raw = snapshot.protocols.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    return [
      log10(p.tvl_usd),
      growthFraction(p),
      log10(age === null ? 365 : Math.max(age, 1)),
      log10(p.chains.length + 1),
      catRate(p),
    ];
  });
  const y = snapshot.protocols.map((p) => (p.mcap_usd !== null ? 1 : 0));
  const k = 5;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < k; j++) {
    const col = raw.map((r) => r[j]!);
    const m = col.reduce((s, v) => s + v, 0) / col.length;
    const v = col.reduce((s, x) => s + (x - m) * (x - m), 0) / col.length;
    mu.push(m);
    sd.push(Math.sqrt(v) || 1);
  }
  const x = raw.map((r) => [1, ...r.map((v, j) => (v - mu[j]!) / sd[j]!)]);
  // Gradient descent, ridge 1.0 on the slopes, step 0.5, 2000 rounds.
  let beta = new Array<number>(k + 1).fill(0);
  for (let round = 0; round < 2000; round++) {
    const grad = new Array<number>(k + 1).fill(0);
    for (let i = 0; i < x.length; i++) {
      const z = x[i]!.reduce((s, v, j) => s + v * beta[j]!, 0);
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j <= k; j++) grad[j]! += x[i]![j]! * err;
    }
    for (let j = 0; j <= k; j++) {
      const pen = j === 0 ? 0 : beta[j]!;
      beta[j]! -= (0.5 / x.length) * (grad[j]! + pen);
    }
  }
  const probs = x.map((row) => sigmoid(row.reduce((s, v, j) => s + v * beta[j]!, 0)));
  let logLoss = 0;
  for (let i = 0; i < y.length; i++) {
    const pr = Math.max(1e-9, Math.min(1 - 1e-9, probs[i]!));
    logLoss += -(y[i]! * Math.log(pr) + (1 - y[i]!) * Math.log(1 - pr));
  }
  logLoss /= y.length;
  // Mann-Whitney AUC over the traded / pre-token pairs.
  let wins = 0;
  let pairs = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] !== 1) continue;
    for (let j = 0; j < y.length; j++) {
      if (y[j] !== 0) continue;
      pairs += 1;
      if (probs[i]! > probs[j]!) wins += 1;
      else if (probs[i] === probs[j]) wins += 0.5;
    }
  }
  // 5-fold cross-validated AUC and log-loss (seeded shuffle, seed 11):
  // the honest out-of-fold figure, not the in-sample one above.
  const cv = (() => {
    const rng = mulberry32(11);
    const order = y.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const chunk = Math.ceil(order.length / 5);
    let aucSum = 0;
    let llSum = 0;
    for (let f = 0; f < 5; f++) {
      const testIdx = new Set(order.slice(f * chunk, (f + 1) * chunk));
      const trainIdx = order.filter((i) => !testIdx.has(i));
      let b = new Array<number>(k + 1).fill(0);
      for (let round = 0; round < 2000; round++) {
        const grad = new Array<number>(k + 1).fill(0);
        for (const i of trainIdx) {
          const z = x[i]!.reduce((s, v, j) => s + v * b[j]!, 0);
          const err = sigmoid(z) - y[i]!;
          for (let j = 0; j <= k; j++) grad[j]! += x[i]![j]! * err;
        }
        for (let j = 0; j <= k; j++) b[j]! -= (0.5 / trainIdx.length) * (grad[j]! + (j === 0 ? 0 : b[j]!));
      }
      const testProbs = [...testIdx].map((i) => sigmoid(x[i]!.reduce((s, v, j) => s + v * b[j]!, 0)));
      const testY = [...testIdx].map((i) => y[i]!);
      let w = 0;
      let prs = 0;
      for (let a = 0; a < testY.length; a++) {
        if (testY[a] !== 1) continue;
        for (let c = 0; c < testY.length; c++) {
          if (testY[c] !== 0) continue;
          prs += 1;
          if (testProbs[a]! > testProbs[c]!) w += 1;
          else if (testProbs[a] === testProbs[c]) w += 0.5;
        }
      }
      aucSum += w / prs;
      let ll = 0;
      for (let a = 0; a < testY.length; a++) {
        const pr = Math.max(1e-9, Math.min(1 - 1e-9, testProbs[a]!));
        ll += -(testY[a]! * Math.log(pr) + (1 - testY[a]!) * Math.log(1 - pr));
      }
      llSum += ll / testY.length;
    }
    return { cvAuc: aucSum / 5, cvLogLoss: llSum / 5 };
  })();
  const oddsOf = (p: SnapshotProtocol): number => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const feats = [
      log10(p.tvl_usd),
      growthFraction(p),
      log10(age === null ? 365 : Math.max(age, 1)),
      log10(p.chains.length + 1),
      catRate(p),
    ];
    const z = beta[0]! + feats.reduce((s, v, j) => s + ((v - mu[j]!) / sd[j]!) * beta[j + 1]!, 0);
    return sigmoid(z);
  };
  return {
    intercept: beta[0]!,
    coefLogTvl: beta[1]!,
    coefGrowth: beta[2]!,
    coefLogAge: beta[3]!,
    coefLogChains: beta[4]!,
    coefCatRate: beta[5]!,
    auc: wins / pairs,
    logLoss,
    cvAuc: cv.cvAuc,
    cvLogLoss: cv.cvLogLoss,
    globalRate,
  };
}

// ---------------------------------------------------------------- flags

/** Why a pre-token protocol is set aside instead of ranked as a farm, or null. */
export function flagReason(p: SnapshotProtocol): string | null {
  if (p.category === 'CEX') return 'exchange (CEX)';
  if (p.category !== null && DROP_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSIONED.test(p.name)) return 'versioned name (a pool of another protocol)';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped / staked product name';
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return 'exchange name';
  return null;
}

// ---------------------------------------------------------------- farm plans

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC into ${chain} with ${name}, then use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as collateral on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one small position in a live market on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset issued through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c === 'chain') return `Bridge $${capital} to ${name} and use its native apps for one swap and one deposit.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Five costed steps, derived from the protocol's own category, chains, TVL and age. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps: FarmStep[] = [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: 'Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; then log the wallet, dates and every transaction.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
  ];
  return steps.map(stepText);
}

// ---------------------------------------------------------------- validation

function medianAbsLogError(beta: number[], rows: SnapshotProtocol[]): number {
  const errs = rows.map((p) => Math.abs(curvePredict(beta, p) - log10(p.mcap_usd!)));
  return median(errs);
}

function fitOn(rows: SnapshotProtocol[]): number[] {
  return huberFit(rows.map(curveRow), rows.map((p) => log10(p.mcap_usd!)), 1.5);
}

/**
 * The validation table, all computed from the snapshot at run time:
 * blind (fit the 32 oldest dated comps, test the 32 newest), four-way
 * held-out by age quartile and by a seeded random split, and
 * leave-one-out over the dated comps.
 */
export function validate(comps: SnapshotProtocol[]): Validation {
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const blindBeta = fitOn(dated.slice(0, half));
  const blindMedian = medianAbsLogError(blindBeta, dated.slice(half));
  const fourWay = (order: number[]): number => {
    const errs: number[] = [];
    const chunk = Math.ceil(order.length / 4);
    for (let f = 0; f < 4; f++) {
      const testIdx = new Set(order.slice(f * chunk, (f + 1) * chunk));
      const trainRows = order.filter((idx) => !testIdx.has(idx)).map((idx) => dated[idx]!);
      const beta = fitOn(trainRows);
      for (const idx of testIdx) errs.push(Math.abs(curvePredict(beta, dated[idx]!) - log10(dated[idx]!.mcap_usd!)));
    }
    return median(errs);
  };
  const ageOrder = dated.map((_, i) => i);
  const rng = mulberry32(7);
  const randOrder = dated.map((_, i) => i);
  for (let i = randOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [randOrder[i], randOrder[j]] = [randOrder[j]!, randOrder[i]!];
  }
  // Leave-one-out over the dated comps.
  const looErrs: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const trainRows = dated.filter((_, k) => k !== i);
    const beta = fitOn(trainRows);
    looErrs.push(Math.abs(curvePredict(beta, dated[i]!) - log10(dated[i]!.mcap_usd!)));
  }
  return {
    blindMedian,
    blindN: dated.length - half,
    fourWayAge: fourWay(ageOrder),
    fourWayRandom: fourWay(randOrder),
    looMedian: median(looErrs),
    looN: dated.length,
  };
}

// ---------------------------------------------------------------- the board

export interface BuiltBoard {
  board: BoardRow[];
  radar: RadarData;
}

function verdictFor(implied: number): string {
  if (implied >= FARM_VERDICT) return 'FARM';
  if (implied >= THIN_VERDICT) return 'THIN';
  return 'SKIP';
}

export function buildRadar(snapshot: Snapshot, variant: 'A' | 'B'): BuiltBoard {
  const comps = compsOf(snapshot);
  const curve = fitCurve(comps);
  const oddsFit = fitOdds(snapshot);
  const validation = validate(comps);
  // The odds of one protocol, from the fitted coefficients. The
  // standardisation constants are the snapshot's own feature means and
  // spreads, recomputed here so the function needs no stored table.
  const muSd = (() => {
    const cats = new Map<string, { traded: number; total: number }>();
    for (const q of snapshot.protocols) {
      const c = q.category ?? 'Other';
      const e = cats.get(c) ?? { traded: 0, total: 0 };
      e.total += 1;
      if (q.mcap_usd !== null) e.traded += 1;
      cats.set(c, e);
    }
    const feats = snapshot.protocols.map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const e = cats.get(p.category ?? 'Other')!;
      return [
        log10(p.tvl_usd),
        growthFraction(p),
        log10(age === null ? 365 : Math.max(age, 1)),
        log10(p.chains.length + 1),
        (e.traded + 20 * oddsFit.globalRate) / (e.total + 20),
      ];
    });
    const mu: number[] = [];
    const sd: number[] = [];
    for (let j = 0; j < 5; j++) {
      const col = feats.map((r) => r[j]!);
      const m = col.reduce((s, v) => s + v, 0) / col.length;
      mu.push(m);
      sd.push(Math.sqrt(col.reduce((s, x) => s + (x - m) * (x - m), 0) / col.length) || 1);
    }
    return { mu, sd, cats };
  })();
  const oddsOf = (p: SnapshotProtocol): number => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const e = muSd.cats.get(p.category ?? 'Other')!;
    const feats = [
      log10(p.tvl_usd),
      growthFraction(p),
      log10(age === null ? 365 : Math.max(age, 1)),
      log10(p.chains.length + 1),
      (e.traded + 20 * oddsFit.globalRate) / (e.total + 20),
    ];
    const z =
      oddsFit.intercept +
      feats.reduce((s, v, j) => s + ((v - muSd.mu[j]!) / muSd.sd[j]!) * [oddsFit.coefLogTvl, oddsFit.coefGrowth, oddsFit.coefLogAge, oddsFit.coefLogChains, oddsFit.coefCatRate][j]!, 0);
    return sigmoid(z);
  };

  const farmable: { p: SnapshotProtocol; launch: number; odds: number | null; implied: number }[] = [];
  const flagged: SideRow[] = [];
  const traded: SideRow[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const launch = launchValue(curve, p);
    if (p.mcap_usd !== null) {
      traded.push({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd, age_days: age, fitted_value_usd: null, reason: 'token already trades' });
      continue;
    }
    const reason = flagReason(p);
    if (reason !== null) {
      flagged.push({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: null, age_days: age, fitted_value_usd: Math.max(1, Math.round(launch * oddsOf(p))), reason });
      continue;
    }
    const o = variant === 'B' ? oddsOf(p) : null;
    farmable.push({ p, launch, odds: o, implied: Math.max(1, Math.round(launch * (o ?? 1))) });
  }
  farmable.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));
  traded.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  flagged.sort((a, b) => (b.fitted_value_usd ?? 0) - (a.fitted_value_usd ?? 0) || (a.slug < b.slug ? -1 : 1));

  // Bootstrap rank ranges: 50 refits of the curve on resampled comps,
  // odds held at the full fit. Seeded, so the ranges never move.
  const rng = mulberry32(20261124);
  const loRank = new Map<string, number>();
  const hiRank = new Map<string, number>();
  for (let refit = 0; refit < 50; refit++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const beta = fitOn(sample);
    const scored = farmable
      .map((f) => ({ slug: f.p.slug, v: Math.max(1, Math.round(Math.pow(10, curvePredict(beta, f.p)) * (f.odds ?? 1))) }))
      .sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => {
      const r = i + 1;
      loRank.set(s.slug, Math.min(loRank.get(s.slug) ?? r, r));
      hiRank.set(s.slug, Math.max(hiRank.get(s.slug) ?? r, r));
    });
  }
  const board: BoardRow[] = farmable.map((f, i) => {
    const age = ageDays(snapshot.as_of, f.p.listed_at);
    return {
      rank: i + 1,
      slug: f.p.slug,
      name: f.p.name,
      category: f.p.category,
      chains: f.p.chains,
      tvl_usd: f.p.tvl_usd,
      change_7d: f.p.change_7d,
      age_days: age,
      launch_value_usd: Math.max(1, Math.round(f.launch)),
      token_odds: f.odds === null ? null : Math.round(f.odds * 1000) / 1000,
      implied_value_usd: f.implied,
      verdict: verdictFor(f.implied),
      rank_lo: loRank.get(f.p.slug) ?? i + 1,
      rank_hi: hiRank.get(f.p.slug) ?? i + 1,
      farm_steps: farmSteps(f.p, age),
    };
  });
  const verdicts = {
    farm: board.filter((r) => r.verdict === 'FARM').length,
    thin: board.filter((r) => r.verdict === 'THIN').length,
    skip: board.filter((r) => r.verdict === 'SKIP').length,
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    variant,
    curve,
    odds: oddsFit,
    validation,
    counts: { scanned: snapshot.protocols.length, farmable: board.length, flagged: flagged.length, traded: traded.length, watchlist: snapshot.watchlist.length },
    watchlist: [...snapshot.watchlist],
    verdicts,
    rows: board,
    flagged,
    traded,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
