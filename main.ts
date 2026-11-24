// Token Radar v8 — three-term fitted value model (Node 22, standard library only).
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), fits every value
// term from the snapshot's own figures, and writes the ranked board, the dashboard data, the
// dashboard, the screenshots and the dossier to /output (or MAKEFUN_OUTPUT_DIR).
//
//   implied value = launch value x token odds x own-token share
//
// Term 1 — launch value: a Huber robust curve on log TVL and 7-day growth, fitted on the
// traded comps (market cap on record, cleaned of exchanges / bridges / staked products and of
// mcap/TVL ratios outside [0.005, 5]). The growth slope is NOT shrunk: a ridge scan on the
// blind time split showed every lambda > 0 worsens the blind median error (lambda 0: 0.2763;
// 0.25: 0.3584; 0.5: 0.3340; 1: 0.3408; 2: 0.3453), so the board ships the plain Huber fit
// and the validation table shows the slope's instability across samples (blind-train 1.7703
// vs a 16-comp half-sample) honestly instead of hiding it behind a shrinkage that costs
// median accuracy. The scan is recomputed at run time and stored in the
// output data (validation.term1.ridgeScan), and the dashboard renders it on
// the page.
// Term 2 — token odds: a logistic fit for P(a protocol ever records a token), over log TVL,
// growth, log age, log chain count, a shrunk category launch rate, TVL against its category
// median, missing-data flags and a growth x age interaction. Standardised, L2 1.0, 500
// gradient steps. Tested held-out (one 80/20 split, seed 7) and 5-fold cross-validated, with
// a calibration table. Odds RISE with age in this snapshot: older protocols have had longer
// to launch (traded rate 3% under 180 days, 29% past 1,100 days), so the age curve on the
// page rises — the fit, not a prior, decides the sign.
// Term 3 — own-token share: the fraction of launch value that accrues to the token and its
// farmers, fitted per category as the shrunk median log-residual of traded comps against the
// launch curve (shrinkage k = 15 toward the global median in variant A, k = 5 in variant B,
// share = 1 in variant C). Held-out tested on the blind time split.
// Uncertainty: conformal intervals per category (90% quantile of |log residual|, shrunk to
// the global quantile) around the implied value, plus bootstrap rank ranges from 50 seeded
// refits of the curve and the share term (odds held at the full fit).
//
// No protocol name is ever special-cased. No network, no API key, no external data: the
// snapshot is the only input. Output is deterministic: every random draw comes from a
// seeded generator, and two runs write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86_400_000;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

// ---------------------------------------------------------------- types

interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: SnapshotProtocol[]; watchlist: string[]; }
class SnapshotError extends Error { constructor(m: string) { super(m); this.name = 'SnapshotError'; } }

// ---------------------------------------------------------------- small utils

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
/** Deterministic PRNG (mulberry32) — the only randomness in the program. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
function growthPct(p: SnapshotProtocol): number {
  return clamp(p.change_7d === null || !Number.isFinite(p.change_7d) ? 0 : p.change_7d, -60, 120);
}

// ---------------------------------------------------------------- snapshot

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

// ---------------------------------------------------------------- classification (the watchlist rule, re-derived)

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const SET_ASIDE_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && SET_ASIDE_CATS.has(p.category)) return p.category;
  if (VERSIONED.test(p.name)) return 'versioned product';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped / staked product';
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return 'exchange product';
  return null;
}
const isTraded = (p: SnapshotProtocol): boolean => p.mcap_usd !== null;
const isFarmable = (p: SnapshotProtocol): boolean => !isTraded(p) && setAsideReason(p) === null;
/** The traded comps the launch curve is fitted on: cleaned exactly as the report states. */
function compsOf(all: SnapshotProtocol[]): SnapshotProtocol[] {
  return all.filter((p) => isTraded(p) && (p.category === null || !SET_ASIDE_CATS.has(p.category)) &&
    p.mcap_usd! / p.tvl_usd >= 0.005 && p.mcap_usd! / p.tvl_usd <= 5.0);
}

// ---------------------------------------------------------------- Term 1: launch curve (plain Huber, no ridge)
//
// The curve is refit from scratch here: log10(mcap) on log10(TVL) and 7-day
// growth, Huber delta 1.5, 80 IRLS rounds, scale 1.4826 x MAD. `ridge` adds a
// penalty to the growth slope only (intercept and TVL slope stay free) so the
// run-time ridge scan can re-fit the blind split at several lambdas; the
// board ships SHIPPED_RIDGE = 0, the only lambda that does not worsen the
// blind median error. See the header comment for the scan numbers.

type Beta = [number, number, number];
/** Ridge lambdas the run-time scan re-fits on the blind split. */
const RIDGE_SCAN = [0, 0.25, 0.5, 1, 2];
/** The ridge the board ships: 0 — the only lambda that does not worsen blind MedAE. */
const SHIPPED_RIDGE = 0;

/** Solve a 3x3 linear system by Gauss-Jordan elimination with partial pivoting. */
function solveLinear3(matrix: number[][], rhs: number[]): number[] {
  const rows = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(rows[r]![col]) > Math.abs(rows[pivot]![col])) pivot = r;
    }
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const diag = Math.abs(rows[col]![col]) < 1e-12 ? 1e-12 : rows[col]![col]!;
    for (let j = col; j < 4; j++) rows[col]![j]! /= diag;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = rows[r]![col]!;
      for (let j = col; j < 4; j++) rows[r]![j]! -= factor * rows[col]![j]!;
    }
  }
  return [rows[0]![3]!, rows[1]![3]!, rows[2]![3]!];
}

/**
 * Huber fit of log10(mcap) = b0 + b1*log10(TVL) + b2*(growth/100).
 * Starts from the plain OLS fit, then reweights by Huber weights until the
 * largest coefficient move drops below 1e-10 (at most 80 rounds). A zero
 * MAD scale falls back to 1 so the weights stay defined.
 */
function huberFit(rows: SnapshotProtocol[], ridge: number): Beta {
  const design = rows.map((p) => [1, Math.log10(p.tvl_usd), growthPct(p) / 100] as const);
  const target = rows.map((p) => Math.log10(p.mcap_usd!));
  const weightedSolve = (weights: number[]): Beta => {
    const normal: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rhs = [0, 0, 0];
    for (let k = 0; k < design.length; k++) {
      const x = design[k]!;
      for (let i = 0; i < 3; i++) {
        rhs[i]! += weights[k]! * x[i]! * target[k]!;
        for (let j = 0; j < 3; j++) normal[i]![j]! += weights[k]! * x[i]! * x[j]!;
      }
    }
    normal[2]![2]! += ridge;
    return solveLinear3(normal, rhs) as Beta;
  };
  const predictRow = (beta: Beta, k: number): number =>
    beta[0] + beta[1] * design[k]![1]! + beta[2] * design[k]![2]!;
  let beta = weightedSolve(design.map(() => 1));
  for (let round = 0; round < 80; round++) {
    const residuals = target.map((y, k) => y - predictRow(beta, k));
    const centre = median(residuals);
    const scale = 1.4826 * median(residuals.map((r) => Math.abs(r - centre))) || 1;
    const weights = residuals.map((r) => {
      const u = Math.abs(r) / (1.5 * scale);
      return u <= 1 ? 1 : 1 / u;
    });
    const next = weightedSolve(weights);
    const moved = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (moved < 1e-10) break;
  }
  return beta;
}
function launchOf(beta: Beta, p: SnapshotProtocol): number {
  return Math.pow(10, beta[0] + beta[1] * Math.log10(p.tvl_usd) + beta[2] * (growthPct(p) / 100));
}
function logErr(beta: Beta, rows: SnapshotProtocol[]): number[] {
  return rows.map((p) => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(launchOf(beta, p))));
}
const mae = (xs: number[]): number => mean(xs);
const mse = (xs: number[]): number => mean(xs.map((x) => x * x));

// ---------------------------------------------------------------- Term 2: token odds (logistic, held-out tested)

interface OddsModel { w: number[]; mu: number[]; sd: number[]; catRate: Map<string, number>; catMed: Map<string, number>; glob: number; }
function oddsFeatures(p: SnapshotProtocol, asOf: string, m: Pick<OddsModel, 'catRate' | 'catMed' | 'glob'>): number[] {
  const a = ageDays(asOf, p.listed_at);
  const logAge = Math.log10(a === null ? 365 : a);
  const g = growthPct(p) / 100;
  const lt = Math.log10(p.tvl_usd);
  const nc = p.chains.length;
  return [
    lt, g, logAge, Math.log10(Math.max(1, nc)),
    m.catRate.get(p.category ?? '') ?? m.glob,
    lt - (m.catMed.get(p.category ?? '') ?? lt),
    p.change_7d === null ? 1 : 0,
    p.listed_at === null ? 1 : 0,
    nc, g * logAge,
  ];
}
function fitOdds(train: SnapshotProtocol[], asOf: string): OddsModel {
  const byCat = new Map<string, [number, number]>();
  for (const p of train) {
    const k = p.category ?? '';
    const e = byCat.get(k) ?? [0, 0];
    e[0] += isTraded(p) ? 1 : 0; e[1] += 1;
    byCat.set(k, e);
  }
  const glob = train.filter(isTraded).length / train.length;
  const catRate = new Map<string, number>();
  const catMed = new Map<string, number>();
  for (const [c, [k, n]] of byCat) {
    catRate.set(c, (k + 5 * glob) / (n + 5));
    const tv = train.filter((p) => (p.category ?? '') === c).map((p) => Math.log10(p.tvl_usd));
    catMed.set(c, median(tv));
  }
  const base = { catRate, catMed, glob };
  const xs = train.map((p) => oddsFeatures(p, asOf, base));
  const ys = train.map((p) => (isTraded(p) ? 1 : 0));
  const k = xs[0]!.length;
  const mu = Array.from({ length: k }, (_, i) => mean(xs.map((x) => x[i]!)));
  const sd = Array.from({ length: k }, (_, i) => {
    const m = mu[i]!;
    const v = mean(xs.map((x) => (x[i]! - m) ** 2));
    return Math.sqrt(v) || 1;
  });
  const z = xs.map((x) => [1, ...x.map((v, i) => (v - mu[i]!) / sd[i]!)]);
  const w = new Array<number>(k + 1).fill(0);
  const lr = 0.5, l2 = 1.0;
  for (let it = 0; it < 500; it++) {
    const grad = new Array<number>(k + 1).fill(0);
    for (let r = 0; r < z.length; r++) {
      const s = z[r]!.reduce((s2, v, i) => s2 + w[i]! * v, 0);
      const pr = 1 / (1 + Math.exp(-clamp(s, -30, 30)));
      for (let i = 0; i <= k; i++) grad[i]! += (pr - ys[r]!) * z[r]![i]!;
    }
    for (let i = 0; i <= k; i++) w[i]! -= lr * (grad[i]! / z.length + (i > 0 ? (l2 * w[i]!) / z.length : 0));
  }
  return { w, mu, sd, catRate, catMed, glob };
}
function oddsOf(m: OddsModel, p: SnapshotProtocol, asOf: string): number {
  const x = oddsFeatures(p, asOf, m);
  const s = m.w[0]! + x.reduce((s2, v, i) => s2 + m.w[i + 1]! * ((v - m.mu[i]!) / m.sd[i]!), 0);
  return 1 / (1 + Math.exp(-clamp(s, -30, 30)));
}
function auc(scores: { s: number; y: number }[]): number {
  const pos = scores.filter((r) => r.y === 1).map((r) => r.s);
  const neg = scores.filter((r) => r.y === 0).map((r) => r.s);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let tot = 0;
  for (const a of pos) for (const b of neg) tot += a > b ? 1 : a === b ? 0.5 : 0;
  return tot / (pos.length * neg.length);
}
function brier(scores: { s: number; y: number }[]): number {
  return mean(scores.map((r) => (r.s - r.y) ** 2));
}

// ---------------------------------------------------------------- Term 3: own-token share (per-category, shrunk)

interface ShareModel { byCat: Map<string, number>; glob: number; shrink: number; }
function fitShare(comps: SnapshotProtocol[], beta: Beta, shrink: number): ShareModel {
  const resid = (p: SnapshotProtocol): number => Math.log10(p.mcap_usd!) - Math.log10(launchOf(beta, p));
  const glob = median(comps.map(resid));
  const byCat = new Map<string, number>();
  const cats = new Map<string, number[]>();
  for (const p of comps) {
    const c = p.category ?? '';
    const arr = cats.get(c) ?? [];
    arr.push(resid(p));
    cats.set(c, arr);
  }
  for (const [c, arr] of cats) {
    const shrunk = (arr.length * median(arr) + shrink * glob) / (arr.length + shrink);
    byCat.set(c, clamp(Math.pow(10, shrunk), 0.5, 2.0));
  }
  return { byCat, glob, shrink };
}
function shareOf(m: ShareModel, p: SnapshotProtocol): number {
  return m.byCat.get(p.category ?? '') ?? clamp(Math.pow(10, m.glob), 0.5, 2.0);
}

// ---------------------------------------------------------------- validation (all computed at run time, all shown on the page)

interface Validation {
  term1: {
    beta: number[]; ridge: number; nComps: number; nDated: number;
    blind: number; blindNaiveMedian: number; blindNaiveTvl: number;
    blindMse: number; blindNaiveMseMedian: number; blindNaiveMseTvl: number;
    blindMed: number; blindNaiveMed: number;
    walkForward: number[]; walkForwardNaive: number[];
    loo: number; looNaive: number; inMae: number;
    blindTrainBeta: number[]; halfSampleBeta: number[];
    ridgeScan: { lambda: number; blindMae: number; blindMed: number }[];
  };
  term2: { cvAuc: number; heldOutAuc: number; heldOutLogLoss: number; brier: number; calibration: { pred: number; actual: number; n: number }[]; ageOdds: { bucket: string; meanOdds: number; tradedRate: number; n: number }[]; };
  term3: { shrink: number; blindWith: number; blindWithout: number; table: { category: string; share: number; n: number }[]; };
  conformal: { qGlobal: number; coverage: number; };
}
function naiveMedianRatio(comps: SnapshotProtocol[]): number {
  return median(comps.map((p) => p.mcap_usd! / p.tvl_usd));
}
function validateAll(snapshot: Snapshot, comps: SnapshotProtocol[], beta: Beta, odds: OddsModel, share: ShareModel, variant: string): Validation {
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const medRatio = naiveMedianRatio(comps);
  const naivePred = (p: SnapshotProtocol, kind: 'median' | 'tvl'): number => kind === 'median' ? p.tvl_usd * medRatio : p.tvl_usd;
  const errOf = (rows: SnapshotProtocol[], pred: (p: SnapshotProtocol) => number): number[] =>
    rows.map((p) => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(pred(p))));
  // Blind time split: fit the 32 oldest dated comps, test the 32 newest.
  const trainB = dated.slice(0, 32), testB = dated.slice(32);
  const betaB = huberFit(trainB, SHIPPED_RIDGE);
  const betaHalf0 = huberFit(dated.slice(0, 16), SHIPPED_RIDGE);
  // Ridge scan: re-fit the blind split at every RIDGE_SCAN lambda so the
  // dossier records why lambda 0 ships — each lambda > 0 worsens blind MedAE.
  const ridgeScan = RIDGE_SCAN.map((lam) => {
    const b = huberFit(trainB, lam);
    const e = errOf(testB, (p) => launchOf(b, p));
    return { lambda: lam, blindMae: r4(mae(e)), blindMed: r4(median(e)) };
  });
  const blind = mae(errOf(testB, (p) => launchOf(betaB, p)));
  const blindMse = mse(errOf(testB, (p) => launchOf(betaB, p)));
  const blindMed = median(errOf(testB, (p) => launchOf(betaB, p)));
  // Walk-forward: four age quartiles, each held out in turn.
  const qs = [0, 1, 2, 3].map((i) => dated.slice(i * 16, (i + 1) * 16));
  const wf: number[] = [], wfN: number[] = [];
  for (let i = 0; i < 4; i++) {
    const train = qs.filter((_, j) => j !== i).flat();
    const b = huberFit(train, SHIPPED_RIDGE);
    wf.push(mae(errOf(qs[i]!, (p) => launchOf(b, p))));
    wfN.push(mae(errOf(qs[i]!, (p) => naivePred(p, 'median'))));
  }
  // Leave-one-out over the 64 dated comps.
  const looErrs: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const train = dated.filter((_, j) => j !== i);
    const b = huberFit(train, SHIPPED_RIDGE);
    looErrs.push(Math.abs(Math.log10(dated[i]!.mcap_usd!) - Math.log10(launchOf(b, dated[i]!))));
  }
  // Odds: 5-fold CV + one held-out 80/20 split (seed 7), both on the full 758.
  const idx = shuffled(snapshot.protocols.map((_, i) => i), 7);
  const folds = [0, 1, 2, 3, 4].map((f) => idx.filter((_, i) => i % 5 === f));
  const cvScores: number[] = [];
  for (let f = 0; f < 5; f++) {
    const testIdx = new Set(folds[f]!);
    const train = snapshot.protocols.filter((_, i) => !testIdx.has(i));
    const test = snapshot.protocols.filter((_, i) => testIdx.has(i));
    const m = fitOdds(train, snapshot.as_of);
    cvScores.push(auc(test.map((p) => ({ s: oddsOf(m, p, snapshot.as_of), y: isTraded(p) ? 1 : 0 }))));
  }
  const heldIdx = new Set(idx.slice(0, 152));
  const oddsTrain = snapshot.protocols.filter((_, i) => !heldIdx.has(i));
  const oddsTest = snapshot.protocols.filter((_, i) => heldIdx.has(i));
  const oddsHeld = fitOdds(oddsTrain, snapshot.as_of);
  const heldScores = oddsTest.map((p) => ({ s: oddsOf(oddsHeld, p, snapshot.as_of), y: isTraded(p) ? 1 : 0 }));
  const heldLL = -mean(heldScores.map((r) => r.y === 1 ? Math.log(Math.max(r.s, 1e-9)) : Math.log(Math.max(1 - r.s, 1e-9))));
  // Calibration quintiles + age-odds buckets on the full fit.
  const fullScores = snapshot.protocols.map((p) => ({ s: oddsOf(odds, p, snapshot.as_of), y: isTraded(p) ? 1 : 0 })).sort((a, b) => a.s - b.s);
  const calibration: Validation['term2']['calibration'] = [];
  for (let q = 0; q < 5; q++) {
    const chunk = fullScores.slice(Math.floor((q * fullScores.length) / 5), Math.floor(((q + 1) * fullScores.length) / 5));
    calibration.push({ pred: r3(mean(chunk.map((r) => r.s))), actual: r3(mean(chunk.map((r) => r.y))), n: chunk.length });
  }
  const buckets: [number, number, string][] = [[0, 180, '0-180d'], [180, 365, '180-365d'], [365, 730, '1-2y'], [730, 1100, '2-3y'], [1100, 100000, '3y+']];
  const ageOdds = buckets.map(([lo, hi, label]) => {
    const sub = snapshot.protocols.filter((p) => { const a = ageDays(snapshot.as_of, p.listed_at); return a !== null && a >= lo && a < hi; });
    return { bucket: label, meanOdds: r3(mean(sub.map((p) => oddsOf(odds, p, snapshot.as_of)))), tradedRate: r3(sub.filter(isTraded).length / Math.max(1, sub.length)), n: sub.length };
  });
  // Share held-out on the blind split (variant C: share is 1, so with == without by construction).
  const shareB = fitShare(trainB, betaB, share.shrink);
  const withShare = variant === 'C' ? mae(errOf(testB, (p) => launchOf(betaB, p)))
    : mae(testB.map((p) => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(launchOf(betaB, p) * shareOf(shareB, p)))));
  const withoutShare = mae(errOf(testB, (p) => launchOf(betaB, p)));
  // Conformal: 90% quantile of |log residual| per category, shrunk to the global quantile.
  const resid = (p: SnapshotProtocol): number => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(launchOf(beta, p)));
  const qGlobal = quantile(comps.map(resid), 0.9);
  const byCatResid = new Map<string, number[]>();
  for (const p of comps) {
    const c = p.category ?? '';
    const arr = byCatResid.get(c) ?? [];
    arr.push(resid(p));
    byCatResid.set(c, arr);
  }
  const qCat = new Map<string, number>();
  for (const [c, arr] of byCatResid) qCat.set(c, (arr.length * quantile(arr, 0.9) + 4 * qGlobal) / (arr.length + 4));
  const coverage = mean(comps.map((p) => {
    const q = qCat.get(p.category ?? '') ?? qGlobal;
    return Math.abs(Math.log10(p.mcap_usd!) - Math.log10(launchOf(beta, p))) <= q ? 1 : 0;
  }));
  const shareTable = [...share.byCat.entries()].map(([category, s]) => ({
    category, share: r3(s),
    n: comps.filter((p) => (p.category ?? '') === category).length,
  })).sort((a, b) => b.share - a.share);
  return {
    term1: {
      beta: [r4(beta[0]), r4(beta[1]), r4(beta[2])], ridge: SHIPPED_RIDGE, nComps: comps.length, nDated: dated.length,
      blind: r4(blind), blindNaiveMedian: r4(mae(errOf(testB, (p) => naivePred(p, 'median')))),
      blindNaiveTvl: r4(mae(errOf(testB, (p) => naivePred(p, 'tvl')))),
      blindMse: r4(blindMse), blindNaiveMseMedian: r4(mse(errOf(testB, (p) => naivePred(p, 'median')))),
      blindNaiveMseTvl: r4(mse(errOf(testB, (p) => naivePred(p, 'tvl')))),
      blindMed: r4(blindMed), blindNaiveMed: r4(median(errOf(testB, (p) => naivePred(p, 'median')))),
      walkForward: wf.map(r4), walkForwardNaive: wfN.map(r4),
      loo: r4(mean(looErrs)), looNaive: r4(mae(errOf(dated, (p) => naivePred(p, 'median')))),
      inMae: r4(mae(logErr(beta, comps))),
      blindTrainBeta: [r4(betaB[0]), r4(betaB[1]), r4(betaB[2])],
      halfSampleBeta: [r4(betaHalf0[0]), r4(betaHalf0[1]), r4(betaHalf0[2])],
      ridgeScan,
    },
    term2: { cvAuc: r3(mean(cvScores)), heldOutAuc: r3(auc(heldScores)), heldOutLogLoss: r3(heldLL), brier: r3(brier(fullScores)), calibration, ageOdds },
    term3: { shrink: share.shrink, blindWith: r4(withShare), blindWithout: r4(withoutShare), table: shareTable },
    conformal: { qGlobal: r4(qGlobal), coverage: r3(coverage) },
  };
}
function conformalQ(validation: Validation, category: string | null, comps: SnapshotProtocol[], beta: Beta): number {
  const resid = (p: SnapshotProtocol): number => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(launchOf(beta, p)));
  const qGlobal = validation.conformal.qGlobal;
  if (category === null) return qGlobal;
  const arr = comps.filter((p) => p.category === category).map(resid);
  if (arr.length < 2) return qGlobal;
  return (arr.length * quantile(arr, 0.9) + 4 * qGlobal) / (arr.length + 4);
}

// ---------------------------------------------------------------- farm plans (deposit-sized, costed, timed)

function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'its main chain'; }
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}
function depositFor(implied: number): number { return implied >= 20_000_000 ? 1000 : implied >= 5_000_000 ? 250 : 50; }
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
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}
function farmSteps(p: SnapshotProtocol, age: number | null, deposit: number): string[] {
  const chain = chainOf(p);
  const hold = holdDaysFor(age);
  const other = deposit === 50 ? '$250 or $1,000' : deposit === 250 ? '$50 or $1,000' : '$50 or $250';
  return [
    stepText('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline', 'under $3 of gas for the first transaction', '5 minutes'),
    stepText(actionFor(p, deposit, chain), `$${deposit} of capital and about $${deposit >= 250 ? 8 : 4} of gas`, '15 minutes to set up'),
    stepText(`Size the position to your deposit: $${deposit} is this plan's size, ${other} scale the same steps up or down without changing them`, `$${deposit} at this size; gas is the same at any size`, '5 minutes to choose'),
    stepText('Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote', 'about $2 of gas a week', '10 minutes a week'),
    stepText(`Hold the position for at least ${hold} days so the activity is counted in more than one snapshot`, `the $${deposit} stays in the position`, `${hold} days`),
    stepText("Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes", 'no fee to check, and never pay to claim', '10 minutes'),
    stepText('Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it', 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- board build

interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: string; age_days: number | null;
  launch_value_usd: number; token_odds: number; own_token_share: number;
  implied_value_usd: number; interval_lo_usd: number; interval_hi_usd: number;
  rank_lo: number; rank_hi: number; deposit_usd: number; verdict: string;
  equation: string; farm_steps: string[];
}
function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
function buildBoard(snapshot: Snapshot, beta: Beta, odds: OddsModel, share: ShareModel, validation: Validation, comps: SnapshotProtocol[], variant: string): { board: BoardRow[]; setAside: Record<string, unknown>[]; traded: Record<string, unknown>[] } {
  const farmable = snapshot.protocols.filter(isFarmable);
  const scored = farmable.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const launch = Math.max(1, Math.round(launchOf(beta, p)));
    const od = oddsOf(odds, p, snapshot.as_of);
    const sh = variant === 'C' ? 1 : shareOf(share, p);
    const implied = Math.max(1, Math.round(launch * od * sh));
    const q = conformalQ(validation, p.category, comps, beta);
    const lo = Math.max(1, Math.round(implied * Math.pow(10, -q)));
    const hi = Math.max(implied + 1, Math.round(implied * Math.pow(10, q)));
    return { p, age, launch, od, sh, implied, lo, hi };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Bootstrap rank ranges: 50 seeded refits of the curve + share (odds held at the full fit).
  const ranksBySlug = new Map<string, number[]>();
  for (const s of scored) ranksBySlug.set(s.p.slug, []);
  for (let b = 0; b < 50; b++) {
    const rnd = mulberry32(1000 + b);
    const resampled: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) resampled.push(comps[Math.floor(rnd() * comps.length)]!);
    const bb = huberFit(resampled, SHIPPED_RIDGE);
    const sb = fitShare(resampled, bb, share.shrink);
    const order = scored.map((s) => ({ slug: s.p.slug, v: launchOf(bb, s.p) * s.od * (variant === 'C' ? 1 : shareOf(sb, s.p)) }))
      .sort((x, y) => y.v - x.v || (x.slug < y.slug ? -1 : 1));
    order.forEach((o, i) => ranksBySlug.get(o.slug)!.push(i + 1));
  }
  const rankRange = (slug: string): [number, number] => {
    const rs = [...ranksBySlug.get(slug)!].sort((a, b) => a - b);
    return [rs[Math.floor(0.05 * (rs.length - 1))]!, rs[Math.ceil(0.95 * (rs.length - 1))]!];
  };
  const board: BoardRow[] = scored.map((s, i) => {
    const [rlo, rhi] = rankRange(s.p.slug);
    const deposit = depositFor(s.implied);
    const verdict = s.implied >= 10_000_000 && s.od >= 0.2 ? 'FARM' : s.implied >= 1_000_000 ? 'THIN' : 'SKIP';
    return {
      rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
      tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id, symbol: s.p.symbol, token_status: 'pre-token', age_days: s.age,
      launch_value_usd: s.launch, token_odds: s.od, own_token_share: s.sh,
      implied_value_usd: s.implied, interval_lo_usd: s.lo, interval_hi_usd: s.hi,
      rank_lo: rlo, rank_hi: rhi, deposit_usd: deposit, verdict,
      equation: `${fmtMoney(s.launch)} x ${s.od.toFixed(3)} odds x ${s.sh.toFixed(3)} share = ${fmtMoney(s.implied)}`,
      farm_steps: farmSteps(s.p, s.age, deposit),
    };
  });
  const setAside = snapshot.protocols.filter((p) => !isTraded(p) && setAsideReason(p) !== null).map((p) => {
    const launch = Math.max(1, Math.round(launchOf(beta, p)));
    const od = oddsOf(odds, p, snapshot.as_of);
    const sh = variant === 'C' ? 1 : shareOf(share, p);
    return { slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, reason: setAsideReason(p), launch_value_usd: launch, token_odds: r3(od), own_token_share: r3(sh), implied_value_usd: Math.max(1, Math.round(launch * od * sh)) };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  const traded = snapshot.protocols.filter(isTraded).map((p) => {
    const launch = Math.max(1, Math.round(launchOf(beta, p)));
    return { slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, launch_value_usd: launch, mcap_over_launch: r3(p.mcap_usd! / launch) };
  }).sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0));
  return { board, setAside, traded };
}
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// ---------------------------------------------------------------- main

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar v8: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const variant = arg('variant', 'A');
if (!['A', 'B', 'C'].includes(variant)) {
  process.stderr.write(`token radar v8: unknown variant ${variant} (A, B or C)\n`);
  process.exit(2);
}
const shrinkK = variant === 'B' ? 5 : 15;

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const comps = compsOf(snapshot.protocols);
const beta = huberFit(comps, SHIPPED_RIDGE);
const odds = fitOdds(snapshot.protocols, snapshot.as_of);
const share = fitShare(comps, beta, shrinkK);
const validation = validateAll(snapshot, comps, beta, odds, share, variant);
const { board, setAside, traded } = buildBoard(snapshot, beta, odds, share, validation, comps, variant);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar v8: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// Nine live self-checks: the page recomputes each one from the data it ships.
const watchlistCovered = snapshot.watchlist.filter((s) => board.some((r) => r.slug === s)).length;
const maxCalGap = Math.max(...validation.term2.calibration.map((c) => Math.abs(c.pred - c.actual)));
const shareInRange = validation.term3.table.every((t) => t.share >= 0.5 && t.share <= 2.0);
const recomputeBad = board.filter((r) => {
  const back = r.launch_value_usd * r.token_odds * r.own_token_share;
  return Math.abs(back - r.implied_value_usd) > Math.max(1, 0.01 * r.implied_value_usd);
}).length;
const checks = [
  { id: 'watchlist', label: `Watchlist ${watchlistCovered}/${snapshot.watchlist.length} covered`, pass: watchlistCovered === snapshot.watchlist.length },
  { id: 'ranks', label: `Ranks 1-${board.length} each once`, pass: new Set(board.map((r) => r.rank)).size === board.length },
  { id: 'order', label: 'Implied value never rises with rank', pass: board.every((r, i) => i === 0 || r.implied_value_usd <= board[i - 1]!.implied_value_usd) },
  { id: 'recompute', label: `Every implied value recomputes from launch x odds x share (${recomputeBad} bad)`, pass: recomputeBad === 0 },
  { id: 'farm', label: `Every row has 7 deposit-sized farm steps`, pass: board.every((r) => r.farm_steps.length === 7 && r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600)) },
  { id: 'audit', label: `Audit adds up: ${board.length} farmable + ${setAside.length} set aside + ${traded.length} traded = ${board.length + setAside.length + traded.length}`, pass: board.length + setAside.length + traded.length === snapshot.protocols.length },
  { id: 'calibration', label: `Odds calibration: worst quintile gap ${maxCalGap.toFixed(3)}`, pass: maxCalGap < 0.08 },
  { id: 'share', label: `Share audit: ${validation.term3.table.length} categories, every share in [0.50, 2.00]`, pass: shareInRange },
  { id: 'conformal', label: `Conformal 90% coverage on comps ${(validation.conformal.coverage * 100).toFixed(0)}%`, pass: validation.conformal.coverage >= 0.8 },
];
const verdictCounts = { FARM: board.filter((r) => r.verdict === 'FARM').length, THIN: board.filter((r) => r.verdict === 'THIN').length, SKIP: board.filter((r) => r.verdict === 'SKIP').length };
const radar = {
  as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
  model_version: 'radar-v8-three-term', variant,
  model: {
    launch: { beta: validation.term1.beta, ridge: SHIPPED_RIDGE, form: 'log10(launch) = b0 + b1*log10(TVL) + b2*(growth/100), Huber delta 1.5, no growth ridge (lambda 0; ridge scan in validation.term1.ridgeScan)' },
    odds: { form: 'logistic on logTVL, growth, logAge, logChains, shrunk category rate, TVL vs category median, missing flags, growth x age; L2 1.0, 500 steps' },
    share: { shrink: shrinkK, form: 'per-category shrunk median log-residual of traded comps vs the launch curve, clamped [0.50, 2.00]' },
  },
  watchlist_size: snapshot.watchlist.length, board_size: board.length,
  early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
  live_size: traded.length, set_aside_size: setAside.length,
  verdicts: verdictCounts,
  validation, checks,
  rows: board, setAside, traded,
};

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
  process.stderr.write(`token radar v8: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar v8: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const t1 = validation.term1;
const t2 = validation.term2;
const t3 = validation.term3;
process.stdout.write(
  `token radar v8 variant ${variant}: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows (${radar.early_size} early), ${setAside.length} set aside, ${traded.length} traded\n` +
  `term1 launch beta [${t1.beta.join(', ')}] ridge ${t1.ridge} on ${t1.nComps} comps (${t1.nDated} dated)\n` +
  `term1 blind MAE ${t1.blind} vs naive median-ratio ${t1.blindNaiveMedian} (x${(t1.blindNaiveMedian / t1.blind).toFixed(2)}) vs naive TVL ${t1.blindNaiveTvl} (x${(t1.blindNaiveTvl / t1.blind).toFixed(2)}); blind MSE ${t1.blindMse} vs median ${t1.blindNaiveMseMedian} (x${(t1.blindNaiveMseMedian / t1.blindMse).toFixed(2)}) vs TVL ${t1.blindNaiveMseTvl} (x${(t1.blindNaiveMseTvl / t1.blindMse).toFixed(2)}); blind MedAE ${t1.blindMed} vs ${t1.blindNaiveMed} (x${(t1.blindNaiveMed / t1.blindMed).toFixed(2)})\n` +
  `term1 ridge scan blind MedAE: ${t1.ridgeScan.map((r) => `lambda ${r.lambda} = ${r.blindMed}`).join(', ')} (lambda 0 ships — the only one that does not worsen the median)\n` +
  `term1 walk-forward MAE [${t1.walkForward.join(', ')}] mean ${mean(t1.walkForward).toFixed(4)} vs naive mean ${mean(t1.walkForwardNaive).toFixed(4)} (x${(mean(t1.walkForwardNaive) / mean(t1.walkForward)).toFixed(2)}); LOO ${t1.loo} vs naive ${t1.looNaive} (x${(t1.looNaive / t1.loo).toFixed(2)})\n` +
  `term1 stability: blind-train growth slope ${t1.blindTrainBeta[2]} vs 16-comp half-sample ${t1.halfSampleBeta[2]} (unstable across samples — shown, not shrunk: every ridge lambda > 0 worsened blind MedAE); shipped full-fit slope ${t1.beta[2]}\n` +
  `term2 odds CV AUC ${t2.cvAuc}, held-out AUC ${t2.heldOutAuc}, held-out log-loss ${t2.heldOutLogLoss}, Brier ${t2.brier}, worst calibration gap ${maxCalGap.toFixed(3)}\n` +
  `term2 age-odds: ${t2.ageOdds.map((b) => `${b.bucket} ${b.meanOdds} (actual ${b.tradedRate}, n=${b.n})`).join('; ')}\n` +
  `term3 share shrink k=${t3.shrink}: blind MAE with share ${t3.blindWith} vs without ${t3.blindWithout}\n` +
  `conformal q90 ${validation.conformal.qGlobal}, coverage ${validation.conformal.coverage}; checks ${checks.filter((c) => c.pass).length}/${checks.length} PASS; verdicts FARM ${verdictCounts.FARM} THIN ${verdictCounts.THIN} SKIP ${verdictCounts.SKIP}\n` +
  `top5: ${board.slice(0, 5).map((r) => `#${r.rank} ${r.name} ${fmtMoney(r.implied_value_usd)}`).join('; ')}\n` +
  `token radar v8: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
