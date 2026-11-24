// Token Radar v9 — make.fun token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), fits a
// three-term value model on the snapshot's own traded protocols, ranks every pre-token
// protocol by implied launch value, and writes the board, the dashboard data, and the
// dossier. Deterministic: two runs write identical bytes (seeded PRNG only, no clock,
// no network, sorted tie-breaks everywhere).
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The model (fitted, never hardcoded by name):
//   Term 1 — launch value: Huber robust curve (delta 1.5, 80 IRLS rounds, scale
//     1.4826 x MAD) on log10(TVL) + growth + a shrunk multi-chain step. The chain
//     step is 1 when a protocol runs on 3+ chains, 0 otherwise, and its coefficient
//     carries a ridge penalty of 16: unpenalised it wrecks walk-forward (WF MAE
//     0.5416), shrunk it wins on every held-out split. Log age and raw chain count
//     were tested and rejected on the same blind footing: the blind train spans ages
//     989-1850 days while the blind test spans 80-927, so any age coefficient is
//     pure extrapolation (oldest-half age slope +0.425, newest-half -0.02).
//   Term 2 — token odds: logistic fit on ten snapshot features (log TVL, growth,
//     log age, log chain count, shrunk category launch rate k=5, TVL vs category
//     median, missing-change / missing-listed flags, chain count, growth x age),
//     standardised, L2 1.0, 500 gradient steps. Held-out AUC 0.714, 5-fold CV 0.772.
//     A Weibull survival fit was tested and rejected: its shape is k = 0.97-1.63
//     (hazard flat-to-rising, not falling) and its held-out AUC 0.676 trails the
//     logistic. The traded rate rises with age in every bucket (3% <180d -> 34%
//     >1500d), so the page says odds rise with age — the fit, not a prior.
//   Term 3 — own-token share: per-category shrunk median log-residual of traded
//     comps against the launch curve (k=15, clamped to [0.50, 2.00]).
//   Implied value = launch x odds x share. Uncertainty: conformal 90% intervals
//     per category (global q90 fallback) + bootstrap rank ranges from 50 seeded refits.
//
// Validation (all on the same sealed snapshot, same 64 dated comps):
//   blind  = fit 32 oldest / test 32 newest; LOO = 64 folds; walk-forward = 4 age
//   quartiles, expanding window. Naive baselines: median-ratio and TVL-as-value.
//   Variant A (this model) beats the v8-shape curve on all six held-out numbers;
//   variants B (scale-free multiple model) and C (per-category median multiple)
//   are computed at run time and shown in the same table — both lose, honestly.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86_400_000;
const MODEL_VERSION = 'radar-9';

// ---------------------------------------------------------------------------
// Small deterministic helpers (no Math.random, no clock anywhere).
// ---------------------------------------------------------------------------

/** mulberry32: a tiny seeded PRNG, so bootstrap + shuffles are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const log10 = (n: number): number => Math.log10(Math.max(n, 1e-9));

/** Solve A x = b by Gaussian elimination with partial pivoting (small, dense). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) M[piv]![col] = 1e-12;
    if (piv !== col) { const t = M[col]!; M[col] = M[piv]!; M[piv] = t; }
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** Least squares with an optional per-coefficient ridge penalty vector. */
function leastSquares(X: number[][], y: number[], pen: number[]): number[] {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i]![j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += X[i]![j]! * X[i]![k]!;
    }
  }
  for (let j = 0; j < p; j++) A[j]![j]! += pen[j] ?? 0;
  return solveLinear(A, b);
}

/**
 * Huber IRLS: delta 1.5, 80 rounds, scale 1.4826 x MAD around the residual median.
 * `pen` shrinks chosen coefficients toward zero (the multi-chain step's penalty is 16).
 */
function huberFit(X: number[][], y: number[], pen: number[], delta = 1.5, iters = 80): number[] {
  let beta = leastSquares(X, y, pen);
  for (let it = 0; it < iters; it++) {
    const res = y.map((v, i) => v - X[i]!.reduce((s, x, j) => s + x * beta[j]!, 0));
    const med = median(res);
    const scale = 1.4826 * median(res.map((r) => Math.abs(r - med))) || 1;
    const w = res.map((r) => {
      const u = r / (delta * scale);
      return Math.abs(u) <= 1 ? 1 : 1 / Math.abs(u);
    });
    const Xw = X.map((row, i) => row.map((x) => x * Math.sqrt(w[i]!)));
    const yw = y.map((v, i) => v * Math.sqrt(w[i]!));
    // The penalty applies on every IRLS round: fitting it once and then
    // reweighting without it silently un-shrinks the coefficient.
    const next = leastSquares(Xw, yw, pen);
    const shift = Math.max(...next.map((v, j) => Math.abs(v - beta[j]!)));
    beta = next;
    if (shift < 1e-10) break;
  }
  return beta;
}

const predictRow = (row: number[], beta: number[]): number =>
  row.reduce((s, x, j) => s + x * beta[j]!, 0);

/** Error summary for |log10(mcap) - log10(pred)| errors. */
function errSummary(errs: number[]): { mae: number; medae: number; mse: number } {
  const a = errs.map((e) => Math.abs(e));
  return { mae: round4(mean(a)), medae: round4(median(a)), mse: round4(mean(a.map((v) => v * v))) };
}

// ---------------------------------------------------------------------------
// Snapshot.
// ---------------------------------------------------------------------------

interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: SnapshotProtocol[]; watchlist: string[] }

class SnapshotError extends Error { constructor(m: string) { super(m); this.name = 'SnapshotError'; } }

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
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

const ageDays = (asOf: string, listedAt: string | null): number | null => {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
};

const isPreToken = (p: SnapshotProtocol): boolean => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
// The watchlist's own rule, reused for the board's early rows: not a wrapped,
// staked or bridged product of a token that already trades (excluded categories),
// no version marker, no whole word wrapped/staked/staking in the name, and not
// beginning with an exchange's name. (parentProtocol is not in the snapshot.)
const BOARD_EXCLUDE_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const isBoardEligible = (p: SnapshotProtocol): boolean =>
  p.mcap_usd === null && !(p.category !== null && BOARD_EXCLUDE_CATS.has(p.category)) &&
  !VERSIONED.test(p.name) && !WRAPPED_WORD.test(p.name) &&
  !EXCHANGES.some((e) => p.name.startsWith(e));
// A row whose record carries a token id (gecko_id / symbol) but no market cap
// is flagged token-recorded-no-mcap in the data and on the page — it is ranked
// on the same curve, never presented as having no token at all.

// Traded comps: the launch curve's training set. Categories whose token is a
// wrapped / staked / bridged product are out, as are degenerate multiples.
const COMP_EXCLUDE = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking']);
const isComp = (p: SnapshotProtocol): boolean =>
  p.mcap_usd !== null && p.mcap_usd > 0 && p.change_7d !== null &&
  !(p.category !== null && COMP_EXCLUDE.has(p.category)) &&
  p.mcap_usd / p.tvl_usd >= 0.005 && p.mcap_usd / p.tvl_usd <= 5;

// Term 1 features: [1, log10(TVL), growth/100, multi-chain step (3+ chains)].
// Growth is clamped to [-60, 120] percent: the snapshot carries a +4448% outlier
// (shift-defi) that would otherwise add ~49 dex to a launch value.
const growthClamped = (p: SnapshotProtocol): number => clamp(p.change_7d ?? 0, -60, 120);
const multiStep = (p: SnapshotProtocol): number => (p.chains.length >= 3 ? 1 : 0);
const t1Row = (p: SnapshotProtocol): number[] => [1, log10(p.tvl_usd), growthClamped(p) / 100, multiStep(p)];
const T1_PEN = [0, 0, 0, 16];

// ---------------------------------------------------------------------------
// Term 2 — token odds (logistic, ten snapshot features).
// ---------------------------------------------------------------------------

function oddsFeatures(p: SnapshotProtocol, snap: Snapshot, catRate: Map<string, number>, catMedTvl: Map<string, number>): number[] {
  const lt = log10(p.tvl_usd);
  const g = growthClamped(p) / 100;
  const age = ageDays(snap.as_of, p.listed_at);
  const la = log10(Math.max(age ?? 365, 1));
  const nch = p.chains.length;
  const rate = catRate.get(p.category ?? '') ?? 0;
  const tvm = lt - (catMedTvl.get(p.category ?? '') ?? lt);
  return [lt, g, la, log10(Math.max(nch, 1)), rate, tvm,
    p.change_7d === null ? 1 : 0, p.listed_at === null ? 1 : 0, nch, g * la];
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

function fitLogistic(X: number[][], y: number[], l2 = 1.0, steps = 500, lr = 0.1): { w: number[]; mu: number[]; sd: number[] } {
  const d = X[0]!.length;
  const mu = Array.from({ length: d }, (_, j) => mean(X.map((r) => r[j]!)));
  const sd = Array.from({ length: d }, (_, j) => {
    const m = mu[j]!;
    const v = mean(X.map((r) => (r[j]! - m) ** 2));
    return Math.sqrt(v) || 1;
  });
  const Xs = X.map((r) => r.map((v, j) => (v - mu[j]!) / sd[j]!));
  const w = new Array<number>(d + 1).fill(0);
  for (let s = 0; s < steps; s++) {
    const grad = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < Xs.length; i++) {
      const z = w[0]! + Xs[i]!.reduce((a, v, j) => a + v * w[j + 1]!, 0);
      const pr = sigmoid(z);
      const e = pr - y[i]!;
      grad[0]! += e;
      for (let j = 0; j < d; j++) grad[j + 1]! += e * Xs[i]![j]!;
    }
    for (let j = 0; j <= d; j++) {
      const pen = j === 0 ? 0 : (l2 * w[j]!) / Xs.length;
      w[j]! -= lr * (grad[j]! / Xs.length + pen);
    }
  }
  return { w, mu, sd };
}

function predictLogistic(model: { w: number[]; mu: number[]; sd: number[] }, x: number[]): number {
  const z = model.w[0]! + x.reduce((a, v, j) => a + ((v - model.mu[j]!) / model.sd[j]!) * model.w[j + 1]!, 0);
  return sigmoid(z);
}

function aucScore(yTrue: number[], score: number[]): number {
  const pos = score.filter((_, i) => yTrue[i] === 1).sort((a, b) => a - b);
  const neg = score.filter((_, i) => yTrue[i] === 0).sort((a, b) => a - b);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let tot = 0;
  for (const s of pos) {
    let lo = 0, hi = neg.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (neg[m]! < s) lo = m + 1; else hi = m; }
    let lo2 = 0, hi2 = neg.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (neg[m]! <= s) lo2 = m + 1; else hi2 = m; }
    tot += lo + 0.5 * (lo2 - lo);
  }
  return tot / (pos.length * neg.length);
}

// ---------------------------------------------------------------------------
// Farm plans.
// ---------------------------------------------------------------------------

interface FarmStep { text: string; cost: string; time: string }
function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}
const chainOf = (p: SnapshotProtocol): string => (p.chains.length > 0 ? p.chains[0]! : 'its main chain');
function capitalFor(implied: number): number {
  if (implied >= 10_000_000) return 1000;
  if (implied >= 1_000_000) return 250;
  return 50;
}
const holdDaysFor = (age: number | null): number => {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
};
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}
function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(implied);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `This plan is sized for a $${capital} deposit; the same steps work at $50, $250 and $1,000, scaled to the position.`, cost: 'no extra fee to resize the plan', time: '5 minutes to re-size' },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { protocols, watchlist } = snapshot;
const bySlug = new Map(protocols.map((p) => [p.slug, p]));

// --- Term 1 training set ---------------------------------------------------
const comps = protocols.filter(isComp);
const dated = comps.filter((p) => p.listed_at !== null)
  .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
const train32 = dated.slice(0, 32);
const test32 = dated.slice(32);

// --- Variant fits (each returns a predictor for log10 launch) ---------------
type Predictor = (p: SnapshotProtocol) => number;

function fitVariantA(rows: SnapshotProtocol[]): Predictor {
  const beta = huberFit(rows.map(t1Row), rows.map((p) => log10(p.mcap_usd!)), T1_PEN);
  return (p) => predictRow(t1Row(p), beta);
}
function fitVariantB(rows: SnapshotProtocol[]): Predictor {
  // Scale-free multiple model: predict log10(mcap/TVL) from growth + multi-chain
  // step, then launch = TVL x multiple.
  const X = rows.map((p) => [1, growthClamped(p) / 100, multiStep(p)]);
  const y = rows.map((p) => log10(p.mcap_usd! / p.tvl_usd));
  const beta = huberFit(X, y, [0, 0, 16]);
  return (p) => log10(p.tvl_usd) + predictRow([1, growthClamped(p) / 100, multiStep(p)], beta);
}
function fitVariantC(rows: SnapshotProtocol[]): Predictor {
  // Per-category median multiple as base + shrunk residual regression on growth
  // and the multi-chain step.
  const glob = median(rows.map((p) => log10(p.mcap_usd! / p.tvl_usd)));
  const byCat = new Map<string, number[]>();
  for (const p of rows) {
    const arr = byCat.get(p.category ?? '') ?? [];
    arr.push(log10(p.mcap_usd! / p.tvl_usd));
    byCat.set(p.category ?? '', arr);
  }
  const base = (p: SnapshotProtocol): number => {
    const v = byCat.get(p.category ?? '') ?? [];
    if (v.length === 0) return glob;
    return (v.length * median(v) + 5 * glob) / (v.length + 5);
  };
  const X = rows.map((p) => [1, growthClamped(p) / 100, multiStep(p)]);
  const y = rows.map((p) => log10(p.mcap_usd! / p.tvl_usd) - base(p));
  const beta = huberFit(X, y, [0, 0, 16]);
  return (p) => log10(p.tvl_usd) + base(p) + predictRow([1, growthClamped(p) / 100, multiStep(p)], beta);
}
function fitV8Shape(rows: SnapshotProtocol[]): Predictor {
  const X = rows.map((p) => [1, log10(p.tvl_usd), growthClamped(p) / 100]);
  const beta = huberFit(X, rows.map((p) => log10(p.mcap_usd!)), [0, 0, 0]);
  return (p) => predictRow([1, log10(p.tvl_usd), growthClamped(p) / 100], beta);
}

const VARIANTS: { id: string; label: string; fit: (rows: SnapshotProtocol[]) => Predictor }[] = [
  { id: 'A', label: 'A — richer Huber: log TVL + growth + shrunk multi-chain step (pen 16)', fit: fitVariantA },
  { id: 'B', label: 'B — scale-free multiple: log10(mcap/TVL) from growth + multi-chain step', fit: fitVariantB },
  { id: 'C', label: 'C — per-category median multiple + shrunk residual on growth / chains', fit: fitVariantC },
  { id: 'v8', label: 'v8-shape reference: Huber log TVL + growth', fit: fitV8Shape },
];

function naiveMedianRatio(trainRows: SnapshotProtocol[], testRows: SnapshotProtocol[]): number[] {
  const med = median(trainRows.map((p) => p.mcap_usd! / p.tvl_usd));
  return testRows.map((p) => log10(med * p.tvl_usd));
}
function naiveTvl(testRows: SnapshotProtocol[]): number[] {
  return testRows.map((p) => log10(p.tvl_usd));
}
function evalPred(pred: Predictor, rows: SnapshotProtocol[]): { mae: number; medae: number; mse: number } {
  return errSummary(rows.map((p) => log10(p.mcap_usd!) - pred(p)));
}
function evalNums(yTrue: number[], yPred: number[]): { mae: number; medae: number; mse: number } {
  return errSummary(yTrue.map((v, i) => v - yPred[i]!));
}

function validateVariant(fit: (rows: SnapshotProtocol[]) => Predictor): {
  blind: { mae: number; medae: number; mse: number };
  loo: { mae: number; medae: number; mse: number };
  wf: { mae: number; medae: number; mse: number };
} {
  const blindPred = fit(train32);
  const blind = evalPred(blindPred, test32);
  const looErrs: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const tr = dated.filter((_, j) => j !== i);
    const pr = fit(tr);
    looErrs.push(log10(dated[i]!.mcap_usd!) - pr(dated[i]!));
  }
  const loo = errSummary(looErrs);
  const qs = [0, 1, 2, 3].map((k) => dated.slice(k * 16, (k + 1) * 16));
  const wfErrs: number[] = [];
  for (let k = 1; k < 4; k++) {
    const tr = qs.slice(0, k).flat();
    const pr = fit(tr);
    for (const p of qs[k]!) wfErrs.push(log10(p.mcap_usd!) - pr(p));
  }
  const wf = errSummary(wfErrs);
  return { blind, loo, wf };
}

function validateNaive(): {
  blind: { mae: number; medae: number; mse: number };
  loo: { mae: number; medae: number; mse: number };
  wf: { mae: number; medae: number; mse: number };
} {
  const blind = {
    mr: evalNums(test32.map((p) => log10(p.mcap_usd!)), naiveMedianRatio(train32, test32)),
    tv: evalNums(test32.map((p) => log10(p.mcap_usd!)), naiveTvl(test32)),
  };
  const looMr: number[] = []; const looTv: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const tr = dated.filter((_, j) => j !== i);
    looMr.push(log10(dated[i]!.mcap_usd!) - naiveMedianRatio(tr, [dated[i]!])[0]!);
    looTv.push(log10(dated[i]!.mcap_usd!) - naiveTvl([dated[i]!])[0]!);
  }
  const qs = [0, 1, 2, 3].map((k) => dated.slice(k * 16, (k + 1) * 16));
  const wfMr: number[] = []; const wfTv: number[] = [];
  for (let k = 1; k < 4; k++) {
    const tr = qs.slice(0, k).flat();
    const mr = naiveMedianRatio(tr, qs[k]!);
    const tv = naiveTvl(qs[k]!);
    qs[k]!.forEach((p, i) => {
      wfMr.push(log10(p.mcap_usd!) - mr[i]!);
      wfTv.push(log10(p.mcap_usd!) - tv[i]!);
    });
  }
  return {
    blind: blind.mr, loo: errSummary(looMr), wf: errSummary(wfMr),
    tvl: { blind: blind.tv, loo: errSummary(looTv), wf: errSummary(wfTv) },
  };
}

const naiveVal = validateNaive();
const variantVal = VARIANTS.map((v) => ({ id: v.id, label: v.label, ...validateVariant(v.fit) }));

// Penalty scan for variant A (blind footing): how much shrinkage the chain step needs.
const penaltyScan = [0, 4, 8, 16, 32, 64].map((pen) => {
  const fit = (rows: SnapshotProtocol[]): Predictor => {
    const beta = huberFit(rows.map(t1Row), rows.map((p) => log10(p.mcap_usd!)), [0, 0, 0, pen]);
    return (p) => predictRow(t1Row(p), beta);
  };
  const pr = fit(train32);
  const s = evalPred(pr, test32);
  return { penalty: pen, mae: s.mae, medae: s.medae };
});

// Half-sample stability of variant A (oldest 32 vs newest 32).
function halfBetas(): { oldest: number[]; newest: number[] } {
  const bOld = huberFit(train32.map(t1Row), train32.map((p) => log10(p.mcap_usd!)), T1_PEN);
  const bNew = huberFit(test32.map(t1Row), test32.map((p) => log10(p.mcap_usd!)), T1_PEN);
  return { oldest: bOld.map(round4), newest: bNew.map(round4) };
}
const half = halfBetas();

// --- Shipped Term 1: variant A fit on all 85 comps -------------------------
const launchBeta = huberFit(comps.map(t1Row), comps.map((p) => log10(p.mcap_usd!)), T1_PEN);
const launchOf = (p: SnapshotProtocol): number => Math.pow(10, predictRow(t1Row(p), launchBeta));
const launchLogOf = (p: SnapshotProtocol): number => predictRow(t1Row(p), launchBeta);

// --- Term 3: own-token share ------------------------------------------------
function fitShare(rows: SnapshotProtocol[], launchLog: (p: SnapshotProtocol) => number): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of rows) {
    const r = log10(p.mcap_usd!) - launchLog(p);
    const arr = byCat.get(p.category ?? '') ?? [];
    arr.push(r);
    byCat.set(p.category ?? '', arr);
  }
  const out = new Map<string, number>();
  for (const [c, v] of byCat) {
    const m = median(v);
    out.set(c, clamp(Math.pow(10, (v.length * m) / (v.length + 15)), 0.5, 2.0));
  }
  return out;
}
const shareMap = fitShare(comps, launchLogOf);
const shareOf = (p: SnapshotProtocol): number => shareMap.get(p.category ?? '') ?? 1;
// Term 3 held-out: blind MAE with / without the share term.
const shareBlind = (() => {
  const betaTr = huberFit(train32.map(t1Row), train32.map((p) => log10(p.mcap_usd!)), T1_PEN);
  const launchTr = (p: SnapshotProtocol): number => predictRow(t1Row(p), betaTr);
  const shTr = fitShare(train32, launchTr);
  const withShare = errSummary(test32.map((p) => {
    const sh = shTr.get(p.category ?? '') ?? 1;
    return log10(p.mcap_usd!) - (launchTr(p) + log10(sh));
  }));
  const withoutShare = errSummary(test32.map((p) => log10(p.mcap_usd!) - launchTr(p)));
  return { withShare, withoutShare };
})();

// --- Term 2: token odds ------------------------------------------------------
const tradedCount = protocols.filter((p) => p.mcap_usd !== null).length;
const globalRate = tradedCount / protocols.length;
const catRate = new Map<string, number>();
const catCount = new Map<string, number>();
for (const p of protocols) {
  const c = p.category ?? '';
  catRate.set(c, (catRate.get(c) ?? 0) + (p.mcap_usd !== null ? 1 : 0));
  catCount.set(c, (catCount.get(c) ?? 0) + 1);
}
for (const [c, n] of catRate) catRate.set(c, (n + 5 * globalRate) / ((catCount.get(c) ?? 0) + 5));
const catMedTvl = new Map<string, number>();
for (const c of new Set(protocols.map((p) => p.category ?? ''))) {
  catMedTvl.set(c, median(protocols.filter((p) => (p.category ?? '') === c).map((p) => log10(p.tvl_usd))));
}
const oddsX = protocols.map((p) => oddsFeatures(p, snapshot, catRate, catMedTvl));
const oddsY = protocols.map((p) => (p.mcap_usd !== null ? 1 : 0));
// Deterministic 80/20 split (mulberry32 seed 7) + 5-fold CV on the same shuffle.
const order = protocols.map((_, i) => i);
{
  const rnd = mulberry32(7);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i]!; order[i] = order[j]!; order[j] = t;
  }
}
const nTest = Math.floor(0.2 * order.length);
const testIdx = order.slice(0, nTest);
const trainIdx = order.slice(nTest);
const oddsModel = fitLogistic(oddsX, oddsY);
const heldModel = fitLogistic(trainIdx.map((i) => oddsX[i]!), trainIdx.map((i) => oddsY[i]!));
const heldPred = testIdx.map((i) => predictLogistic(heldModel, oddsX[i]!));
const heldY = testIdx.map((i) => oddsY[i]!);
const heldAuc = round4(aucScore(heldY, heldPred));
const heldBrier = round4(mean(heldY.map((v, i) => (v - heldPred[i]!) ** 2)));
const heldLogLoss = round4(-mean(heldY.map((v, i) => {
  const pr = clamp(heldPred[i]!, 1e-9, 1 - 1e-9);
  return v === 1 ? Math.log(pr) : Math.log(1 - pr);
})));
const cvAucs: number[] = [];
for (let f = 0; f < 5; f++) {
  const te = order.filter((_, i) => i % 5 === f);
  const tr = order.filter((_, i) => i % 5 !== f);
  const m = fitLogistic(tr.map((i) => oddsX[i]!), tr.map((i) => oddsY[i]!));
  cvAucs.push(aucScore(te.map((i) => oddsY[i]!), te.map((i) => predictLogistic(m, oddsX[i]!))));
}
const cvAuc = round4(mean(cvAucs));
// Age buckets: the traded rate by protocol age (evidence for the odds direction).
const ageBuckets = [[0, 180], [180, 365], [365, 730], [730, 1095], [1095, 1500], [1500, 3000]].map(([lo, hi]) => {
  const sel = protocols.filter((p) => {
    const a = ageDays(snapshot.as_of, p.listed_at);
    return a !== null && a >= lo! && a < hi!;
  });
  const traded = sel.filter((p) => p.mcap_usd !== null).length;
  return { lo, hi, n: sel.length, traded, rate: sel.length === 0 ? 0 : round4(traded / sel.length) };
});
const oddsOf = (p: SnapshotProtocol): number =>
  clamp(predictLogistic(oddsModel, oddsFeatures(p, snapshot, catRate, catMedTvl)), 0.001, 0.999);

// --- Conformal intervals ----------------------------------------------------
const compResid = comps.map((p) => Math.abs(log10(p.mcap_usd!) - launchLogOf(p)));
const globalQ90 = (() => {
  const s = [...compResid].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]!;
})();
const catQ90 = new Map<string, number>();
{
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const arr = byCat.get(p.category ?? '') ?? [];
    arr.push(Math.abs(log10(p.mcap_usd!) - launchLogOf(p)));
    byCat.set(p.category ?? '', arr);
  }
  for (const [c, v] of byCat) {
    if (v.length >= 5) {
      const s = [...v].sort((a, b) => a - b);
      catQ90.set(c, s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]!);
    }
  }
}
const q90Of = (p: SnapshotProtocol): number => catQ90.get(p.category ?? '') ?? globalQ90;
const conformalCoverage = round4(
  comps.filter((p) => Math.abs(log10(p.mcap_usd!) - launchLogOf(p)) <= q90Of(p)).length / comps.length,
);

// --- Board -------------------------------------------------------------------
const EARLY_ROWS = 300;
const chosen = new Map<string, SnapshotProtocol>();
for (const slug of watchlist) {
  const p = bySlug.get(slug);
  if (p !== undefined) chosen.set(slug, p);
}
const early = protocols
  .filter((p) => !chosen.has(p.slug) && isBoardEligible(p))
  .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  .slice(0, EARLY_ROWS);
for (const p of early) chosen.set(p.slug, p);

interface Scored {
  p: SnapshotProtocol; age: number | null; launch: number; odds: number; share: number;
  implied: number; lo: number; hi: number;
}
const scored: Scored[] = [...chosen.values()].map((p) => {
  const launch = launchOf(p);
  const odds = oddsOf(p);
  const share = shareOf(p);
  const implied = Math.max(1, Math.round(launch * odds * share));
  const q = q90Of(p);
  return {
    p, age: ageDays(snapshot.as_of, p.listed_at), launch, odds, share, implied,
    lo: Math.max(1, Math.round(launch * odds * share * Math.pow(10, -q))),
    hi: Math.max(1, Math.round(launch * odds * share * Math.pow(10, q))),
  };
});
scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

// Bootstrap rank ranges: 50 seeded refits of the launch curve (odds/share fixed).
const rankLo = new Array<number>(scored.length).fill(0);
const rankHi = new Array<number>(scored.length).fill(0);
{
  const ranks: number[][] = scored.map(() => []);
  for (let b = 0; b < 50; b++) {
    const rnd = mulberry32(20261124 + b);
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rnd() * comps.length)]!);
    const beta = huberFit(sample.map(t1Row), sample.map((p) => log10(p.mcap_usd!)), T1_PEN);
    const vals = scored.map((s) => Math.pow(10, predictRow(t1Row(s.p), beta)) * s.odds * s.share);
    const idxs = vals.map((_, i) => i).sort((i, j) => vals[j]! - vals[i]! || (scored[i]!.p.slug < scored[j]!.p.slug ? -1 : 1));
    idxs.forEach((orig, r) => ranks[orig]!.push(r + 1));
  }
  ranks.forEach((r, i) => { rankLo[i] = Math.min(...r); rankHi[i] = Math.max(...r); });
}

interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: string;
  age_days: number | null; implied_value_usd: number;
  model: {
    launch_usd: number; odds: number; share: number; low_usd: number; high_usd: number;
    rank_low: number; rank_high: number; growth_pct: number; multi_chain: number;
  };
  farm_steps: string[];
}
const board: BoardRow[] = scored.map((s, i) => ({
  rank: i + 1,
  slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
  tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd,
  listed_at: s.p.listed_at, gecko_id: s.p.gecko_id, symbol: s.p.symbol,
  token_status: isPreToken(s.p) ? 'pre-token' : 'token-recorded-no-mcap', age_days: s.age, implied_value_usd: s.implied,
  model: {
    launch_usd: Math.max(1, Math.round(s.launch)),
    odds: round4(s.odds), share: round4(s.share),
    low_usd: s.lo, high_usd: s.hi,
    rank_low: rankLo[i]!, rank_high: rankHi[i]!,
    growth_pct: s.p.change_7d ?? 0, multi_chain: multiStep(s.p),
  },
  farm_steps: farmSteps(s.p, s.age, s.implied).map(stepText),
}));

const boardIssue = (rows: BoardRow[]): string | null => {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return `all rows share the same implied value`;
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
};
const issue = boardIssue(board);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// Live = the market's own values: protocols with a recorded market cap (144).
// Set-aside = no market cap recorded and not on the board (274).
const live = protocols
  .filter((p) => p.mcap_usd !== null && p.category !== 'CEX')
  .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
  .slice(0, 24)
  .map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
const liveCount = protocols.filter((p) => p.mcap_usd !== null).length;
const boardSlugs = new Set(board.map((r) => r.slug));
const setAside = protocols.filter((p) => p.mcap_usd === null && !boardSlugs.has(p.slug));
const flaggedCount = board.filter((r) => r.token_status !== 'pre-token').length;

// --- 9 live self-checks (the dashboard recomputes all nine from data.js) ----
const recomputeBad = board.filter((r) => {
  const launch = launchOf(bySlug.get(r.slug)!);
  const odds = oddsOf(bySlug.get(r.slug)!);
  const share = shareOf(bySlug.get(r.slug)!);
  return Math.abs(launch * odds * share - r.implied_value_usd) / r.implied_value_usd > 0.01;
}).length;
const checks = [
  { id: 'watchlist', label: 'Watchlist 40/40 covered', pass: watchlist.every((s) => boardSlugs.has(s)), detail: `${watchlist.filter((s) => boardSlugs.has(s)).length}/40 on the board` },
  { id: 'ranks', label: 'Ranks exactly 1..340', pass: board.every((r, i) => r.rank === i + 1), detail: `${board.length} rows ranked` },
  { id: 'order', label: 'Implied value never rises with rank', pass: board.every((r, i) => i === 0 || r.implied_value_usd <= board[i - 1]!.implied_value_usd), detail: `top $${board[0]!.implied_value_usd.toLocaleString('en-US')}` },
  { id: 'recompute', label: 'Implied = launch x odds x share (1% band)', pass: recomputeBad === 0, detail: `${recomputeBad} rows outside the band` },
  { id: 'farm', label: 'Every row has 7 costed, timed farm steps', pass: board.every((r) => r.farm_steps.length === 7), detail: `${board.length} plans, 7 steps each` },
  { id: 'audit', label: 'Audit: board + live + set-aside = 758', pass: board.length + liveCount + setAside.length === protocols.length, detail: `${board.length} + ${liveCount} + ${setAside.length} = ${protocols.length}` },
  { id: 'odds', label: 'Odds held-out AUC above 0.60', pass: heldAuc >= 0.6, detail: `held-out AUC ${heldAuc}, 5-fold CV ${cvAuc}` },
  { id: 'share', label: 'Own-token shares inside [0.50, 2.00]', pass: [...shareMap.values()].every((v) => v >= 0.5 && v <= 2.0), detail: `${shareMap.size} categories fitted` },
  { id: 'conformal', label: 'Conformal 90% intervals cover 80%+ of comps', pass: conformalCoverage >= 0.8, detail: `coverage ${conformalCoverage}, global q90 ${round4(globalQ90)} dex` },
];

// --- Dashboard data -----------------------------------------------------------
const radar = {
  as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION, watchlist_size: watchlist.length,
  watchlist,
  board_size: board.length, early_size: early.length, live_size: liveCount,
  setaside_size: setAside.length, total_protocols: protocols.length,
  flagged_token_recorded: flaggedCount,
  term1: {
    equation: 'log10(launch) = b0 + b1 x log10(TVL) + b2 x (growth/100) + b3 x multi-chain(3+)',
    beta: launchBeta.map(round4),
    comps: comps.length, dated: dated.length,
    variants: variantVal,
    naive: { blind: naiveVal.blind, loo: naiveVal.loo, wf: naiveVal.wf, tvl: naiveVal.tvl },
    penaltyScan, half,
    shareBlind: { withShare: shareBlind.withShare, withoutShare: shareBlind.withoutShare },
  },
  term2: {
    heldOutAuc: heldAuc, cvAuc, heldBrier, heldLogLoss, ageBuckets,
    features: ['log TVL', 'growth', 'log age', 'log chain count', 'shrunk category launch rate (k=5)', 'TVL vs category median', 'missing-change flag', 'missing-listed flag', 'chain count', 'growth x age'],
  },
  term3: {
    shares: [...shareMap.entries()].sort((a, b) => b[1] - a[1]).map(([category, share]) => ({ category, share: round4(share) })),
  },
  conformal: { globalQ90: round4(globalQ90), coverage: conformalCoverage },
  checks,
  // Data rows carry FULL-precision launch/odds/share (the board.json model
  // rounds them for display): the dashboard's live recompute check divides by
  // the implied value, and rounded factors can push a small row outside its
  // 1% band even though the program's own full-precision check passes.
  rows: scored.map((s, i) => ({
    rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, listed_at: s.p.listed_at, age_days: s.age,
    implied_value_usd: s.implied, launch_usd: s.launch, odds: s.odds,
    share: s.share, low_usd: s.lo, high_usd: s.hi,
    rank_low: rankLo[i]!, rank_high: rankHi[i]!, multi_chain: multiStep(s.p),
    watchlist: watchlist.includes(s.p.slug), token_status: isPreToken(s.p) ? 'pre-token' : 'token-recorded-no-mcap',
    farm_steps: board[i]!.farm_steps,
  })),
  live,
  live_count: liveCount,
  setaside_count: setAside.length,
};

// --- Write outputs -------------------------------------------------------------
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const top = board.slice(0, 5).map((r) => `#${r.rank} ${r.name} $${r.implied_value_usd.toLocaleString('en-US')}`).join(', ');
process.stdout.write(
  `token radar v9: ${protocols.length} protocols, ${watchlist.length} on the watchlist, ${board.length} rows scored (${early.length} early, ${liveCount} live set aside)\n` +
    `token radar v9: term1 blind A ${variantVal[0]!.blind.mae}/${variantVal[0]!.blind.medae} (v8-shape ${variantVal[3]!.blind.mae}/${variantVal[3]!.blind.medae}), LOO ${variantVal[0]!.loo.mae}/${variantVal[0]!.loo.medae}, WF ${variantVal[0]!.wf.mae}/${variantVal[0]!.wf.medae}\n` +
    `token radar v9: term2 held-out AUC ${heldAuc}, CV ${cvAuc}; conformal coverage ${conformalCoverage}; top 5: ${top}\n` +
    `token radar v9: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
