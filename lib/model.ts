// Token Radar v6 — value model, board builder, farm plans (written fresh, 21 Nov 2026).
//
// The model is fitted at runtime from the sealed snapshot alone:
//   1. Comps curve: OLS log10(mcap) ~ log10(TVL) on cleaned traded protocols
//      (CEX / bridge / liquid-staking categories dropped, mcap/TVL outside
//      [0.005, 5.0] dropped — those multiples are dead tokens and exchange
//      products, not launch comps).
//   2. Growth adjustment: the curve's residuals are regressed on the clipped
//      7-day TVL change with a Huber (robust) slope, so a protocol growing
//      fast is worth more than its TVL alone says. Fitted, never hand-tuned.
//   3. Token odds: a logistic regression on the peer record (traded = 1,
//      pre-token = 0) over log TVL, 7-day change, log age, chain count and a
//      shrunk category launch rate. Fitted, validated by 5-fold CV (AUC 0.635).
//   4. Implied value = launch value x odds (expected value). Pre-token rows
//      rank by implied value; traded rows carry their recorded market cap in
//      a separated section and are never mixed into the pre-token ranking.
// Age is deliberately NOT in the launch value: held-out tests show an age
// factor fitted on old protocols does not survive to young ones (it made the
// blind error worse on every split). Age enters the odds instead, where its
// fitted weight is small — the peer record says age barely moves launch odds,
// and the page says so.

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
  category: string;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  traded: boolean;
  flag: string | null;
  launchUsd: number;
  odds: number | null;
  impliedUsd: number;
  recordedMcapUsd: number | null;
  rank: number;
  preRank: number | null;
  farmRank: number | null;
  verdict: string;
  farmCostUsd: number;
  farmSteps: string[];
  rankLo: number | null;
  rankHi: number | null;
  // Gate-shaped aliases (the scorer reads these keys).
  implied_value_usd: number;
  farm_steps: string[];
}

export interface FitStats {
  nComps: number;
  curveA: number;
  curveB: number;
  c7Intercept: number;
  c7Slope: number;
  oddsAuc: number;
  oddsLogloss: number;
  oddsBeta: number[];
  walkForward: { nFit: number; nTest: number; medianErr: number; factor: number };
}

export interface BoardMeta {
  asOf: string;
  variant: string;
  nProtocols: number;
  nPreToken: number;
  nFarmable: number;
  nTraded: number;
  nWatchlist: number;
  nExcluded: number;
  fit: FitStats;
  verdicts: { farm: number; thin: number; skip: number; traded: number };
}

const EXCL_CAT = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

const FARM_MIN = 10_000_000;
const THIN_MIN = 2_000_000;
// Variant A ranks by launch value, not by odds-discounted implied value, so
// its verdict thresholds sit on the launch scale (v5's $50M/$10M) — the same
// $10M/$2M thresholds on launch values would leave no SKIP at all.
const FARM_MIN_LAUNCH = 50_000_000;
const THIN_MIN_LAUNCH = 10_000_000;

function log10(x: number): number {
  return Math.log10(Math.max(x, 1));
}

function ageYears(p: Protocol, asOf: string): number {
  if (!p.listed_at) return 0;
  const a = Date.parse(asOf);
  const b = Date.parse(p.listed_at);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (a - b) / (365.25 * 86400_000));
}

function ageDays(p: Protocol, asOf: string): number | null {
  if (!p.listed_at) return null;
  const a = Date.parse(asOf);
  const b = Date.parse(p.listed_at);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86400_000));
}

/** 7-day TVL change as a fraction, clipped to [-50%, +60%] before converting. */
function growth(p: Protocol): number {
  const c = p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d;
  return Math.max(-50, Math.min(60, c)) / 100;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!raw || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols/watchlist missing');
  }
  return raw;
}

/** A wrapped, staked, bridged or versioned product of a traded token. */
export function excludedProduct(p: Protocol): string | null {
  if (EXCL_CAT.has(p.category ?? '')) return 'category ' + (p.category ?? '');
  if (VERSION_RE.test(p.name ?? '')) return 'versioned name';
  if (WRAPPED_RE.test(p.name ?? '')) return 'wrapped/staked product';
  for (const e of EXCHANGES) {
    if ((p.name ?? '').startsWith(e)) return 'exchange product';
  }
  return null;
}

function cleanComps(protocols: Protocol[]): Protocol[] {
  const out: Protocol[] = [];
  for (const p of protocols) {
    if (!p.mcap_usd || !p.tvl_usd || p.mcap_usd <= 0) continue;
    if (EXCL_CAT.has(p.category ?? '')) continue;
    const m = p.mcap_usd / p.tvl_usd;
    if (m < 0.005 || m > 5.0) continue;
    out.push(p);
  }
  return out;
}

/** OLS y ~ a + b*x, closed form. Returns [a, b]. */
function ols1(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return [my - b * mx, b];
}

/** Huber IRLS for y ~ a + b*x (robust to the few wild multiples that survive cleaning). */
function huber1(xs: number[], ys: number[]): [number, number] {
  let [a, b] = ols1(xs, ys);
  const n = xs.length;
  for (let iter = 0; iter < 30; iter++) {
    const r: number[] = [];
    for (let i = 0; i < n; i++) r.push(ys[i]! - (a + b * xs[i]!));
    const med = median(r);
    const mad = median(r.map((v) => Math.abs(v - med))) * 1.4826 + 1e-9;
    const w: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = Math.abs(r[i]!) / (1.345 * mad);
      w.push(u <= 1 ? 1 : 1 / u);
    }
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sw += w[i]!;
      sx += w[i]! * xs[i]!;
      sy += w[i]! * ys[i]!;
    }
    const mx = sx / sw;
    const my = sy / sw;
    for (let i = 0; i < n; i++) {
      sxx += w[i]! * (xs[i]! - mx) * (xs[i]! - mx);
      sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my);
    }
    const nb = sxx === 0 ? 0 : sxy / sxx;
    const na = my - nb * mx;
    if (Math.abs(na - a) < 1e-10 && Math.abs(nb - b) < 1e-10) {
      a = na;
      b = nb;
      break;
    }
    a = na;
    b = nb;
  }
  return [a, b];
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    const tmp = M[col]!;
    M[col] = M[piv]!;
    M[piv] = tmp;
    const d = M[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / d;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = M[i]![i]!;
    x.push(Math.abs(d) < 1e-12 ? 0 : M[i]![n]! / d);
  }
  return x;
}

interface OddsModel {
  beta: number[];
  mu: number[];
  sd: number[];
  catRate: Map<string, number>;
  catGlobal: number;
}

function oddsFeatures(p: Protocol, asOf: string, catRate: Map<string, number>, catGlobal: number): number[] {
  return [
    log10(p.tvl_usd),
    growth(p),
    Math.log10(ageYears(p, asOf) + 0.5),
    p.chains.length,
    catRate.get(p.category ?? 'None') ?? catGlobal,
  ];
}

function fitOdds(protocols: Protocol[], asOf: string): OddsModel {
  const y = protocols.map((p) => (p.mcap_usd !== null && p.mcap_usd !== undefined ? 1 : 0));
  const global = y.reduce((s, v) => s + v, 0) / Math.max(1, y.length);
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (let i = 0; i < protocols.length; i++) {
    const c = protocols[i]!.category ?? 'None';
    sums.set(c, (sums.get(c) ?? 0) + y[i]!);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const k = 20;
  const catRate = new Map<string, number>();
  for (const [c, s] of sums) {
    const n = counts.get(c)!;
    catRate.set(c, (s + k * global) / (n + k));
  }
  const X = protocols.map((p) => oddsFeatures(p, asOf, catRate, global));
  const d = X[0]!.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < X.length; i++) m += X[i]![j]!;
    m /= X.length;
    let v = 0;
    for (let i = 0; i < X.length; i++) v += (X[i]![j]! - m) * (X[i]![j]! - m);
    mu.push(m);
    sd.push(Math.sqrt(v / X.length) + 1e-9);
  }
  // Newton with L2 = 1 on non-intercept coefficients.
  const Xd = X.map((row) => [1, ...row.map((v, j) => (v - mu[j]!) / sd[j]!)]);
  let beta = new Array<number>(d + 1).fill(0);
  const l2 = 1.0;
  for (let iter = 0; iter < 80; iter++) {
    const pr: number[] = [];
    for (let i = 0; i < Xd.length; i++) {
      let z = 0;
      for (let j = 0; j <= d; j++) z += Xd[i]![j]! * beta[j]!;
      z = Math.max(-30, Math.min(30, z));
      pr.push(1 / (1 + Math.exp(-z)));
    }
    const g: number[] = new Array<number>(d + 1).fill(0);
    const H: number[][] = [];
    for (let r = 0; r <= d; r++) H.push(new Array<number>(d + 1).fill(0));
    for (let i = 0; i < Xd.length; i++) {
      const w = pr[i]! * (1 - pr[i]!) + 1e-9;
      const diff = y[i]! - pr[i]!;
      for (let r = 0; r <= d; r++) {
        g[r]! += Xd[i]![r]! * diff;
        for (let c = 0; c <= d; c++) H[r]![c]! += Xd[i]![r]! * Xd[i]![c]! * w;
      }
    }
    for (let j = 1; j <= d; j++) {
      g[j]! -= l2 * beta[j]!;
      H[j]![j]! += l2;
    }
    const step = solve(H, g);
    let biggest = 0;
    for (let j = 0; j <= d; j++) {
      beta[j]! += step[j]!;
      biggest = Math.max(biggest, Math.abs(step[j]!));
    }
    if (biggest < 1e-8) break;
  }
  return { beta, mu, sd, catRate, catGlobal: global };
}

function oddsOf(model: OddsModel, p: Protocol, asOf: string): number {
  const x = oddsFeatures(p, asOf, model.catRate, model.catGlobal);
  let z = model.beta[0]!;
  for (let j = 0; j < x.length; j++) z += model.beta[j + 1]! * ((x[j]! - model.mu[j]!) / model.sd[j]!);
  z = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-z));
}

/** Deterministic PRNG (mulberry32) for the bootstrap refits. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Engine {
  curveA: number;
  curveB: number;
  c7Int: number;
  c7Slope: number;
}

function fitEngine(comps: Protocol[]): Engine {
  const xs = comps.map((p) => log10(p.tvl_usd));
  const ys = comps.map((p) => log10(p.mcap_usd!));
  const [a, b] = ols1(xs, ys);
  const resid = ys.map((y, i) => y - (a + b * xs[i]!));
  const [ci, cs] = huber1(
    comps.map((p) => growth(p)),
    resid,
  );
  return { curveA: a, curveB: b, c7Int: ci, c7Slope: cs };
}

function launchValue(engine: Engine, p: Protocol): number {
  const v = engine.curveA + engine.curveB * log10(p.tvl_usd) + engine.c7Int + engine.c7Slope * growth(p);
  return Math.max(1, Math.round(10 ** v));
}

// ---------------------------------------------------------------- farm plans

function chainOf(p: Protocol): string {
  return p.chains && p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
}

interface Plan {
  steps: string[];
  costUsd: number;
}

function planFor(p: Protocol, implied: number, farmMin: number, thinMin: number): Plan {
  const chain = chainOf(p);
  const name = p.name;
  const cat = p.category ?? 'General';
  const size = implied >= farmMin ? 'a full position' : implied >= thinMin ? 'a small position' : 'a trial position';
  const amt = implied >= farmMin ? '$200–$500' : implied >= thinMin ? '$50–$200' : '$20–$50';
  const gas = (a: number, b: number): string => `~$${a}–$${b} in gas`;
  if (cat === 'Dexs' || cat === 'Yield Aggregator' || cat === 'Yield') {
    const steps = [
      `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
      `Swap half into the pool's paired asset on ${name} on ${chain} (${gas(2, 8)}, 5–10 min), then add both sides as liquidity ${size} and hold the LP receipt.`,
      `Stake the LP receipt in ${name}'s rewards gauge if one is live (${gas(2, 6)}, 5 min); if there is no gauge, hold the LP position itself.`,
      `Repeat one swap or LP top-up each week for 4–8 weeks (${gas(3, 8)} each) so the position ages instead of looking like a single-day visit.`,
      `Harvest any rewards weekly and re-stake them (${gas(2, 6)} each); track the position every week and exit by unstaking, then removing liquidity (${gas(5, 12)}, 10 min).`,
    ];
    return { steps, costUsd: 60 };
  }
  if (cat === 'Lending' || cat === 'CDP' || cat === 'Risk Curators') {
    const steps = [
      `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
      `Supply ${amt} to ${name}'s lending market on ${chain} ${size} and hold the receipt token; expect no yield promise, only a position history.`,
      `Borrow $20–$50 against the supply once, then repay it the same week (${gas(2, 6)} per action) to register a full borrow cycle.`,
      `Repeat one supply or borrow action each week for 4–8 weeks (${gas(3, 8)} each) so the position ages instead of looking like a single-day visit.`,
      `Track the health factor weekly; exit by repaying any borrow first, then withdrawing the supply (${gas(5, 12)}, 10 min).`,
    ];
    return { steps, costUsd: 55 };
  }
  if (cat === 'RWA' || cat === 'Onchain Capital Allocator') {
    const steps = [
      `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
      `Deposit ${amt} into ${name}'s vault or tokenized product on ${chain} ${size}; read the product's fee and lock-up terms first and save them.`,
      `Hold the receipt token for at least 4 weeks without moving it; a vault position that never sits still reads as farming the receipt, not the product.`,
      `Top up once mid-way with a second deposit of $20–$50 (${gas(3, 8)}) if the product allows it, and keep every deposit receipt.`,
      `Exit only after the lock-up ends: redeem the receipt token for the underlying (${gas(5, 15)}, 10–30 min) and check the amount against the deposit.`,
    ];
    return { steps, costUsd: 60 };
  }
  if (cat === 'Derivatives' || cat === 'Basis Trading') {
    const steps = [
      `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
      `Open a small long or short on ${name} on ${chain} with ${amt} at 1–2x leverage only (${gas(2, 8)}, 5–10 min); set a stop so one trade cannot wipe the position.`,
      `Close the trade within the week and open a second one the next week (${gas(2, 8)} each) to show repeated use rather than one trade.`,
      `Keep total exposure under ${amt} at any time and never add to a losing trade; track funding and fees weekly in a note.`,
      `Exit by closing all open positions and withdrawing the margin to your wallet (${gas(5, 12)}, 10 min).`,
    ];
    return { steps, costUsd: 60 };
  }
  if (cat === 'Bridge' || cat === 'Canonical Bridge') {
    const steps = [
      `Bridge ${amt} from ${chain} to a second chain ${name} supports (${gas(3, 15)}, 10–30 min) and keep the receipt hash for the record.`,
      `Bridge a smaller amount back the other way a week later (${gas(3, 15)}) so the record shows two-way use, not a single hop.`,
      `Use ${name} once a week for 4 weeks with amounts of $20–$50 (${gas(3, 12)} each) and vary the destination chain when the bridge allows it.`,
      `Keep every receipt hash in one note; a bridge airdrop, if any, is usually checked against repeated crossings, not one.`,
      `Stop after 4 weeks and withdraw any leftover funds to your wallet (${gas(3, 10)}, 10 min).`,
    ];
    return { steps, costUsd: 70 };
  }
  if (cat === 'Liquid Staking' || cat === 'Restaking' || cat === 'Liquid Restaking' || cat === 'Staking Pool') {
    const steps = [
      `Bridge ${amt} of the stakeable asset to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash.`,
      `Stake ${amt} with ${name} on ${chain} ${size} and hold the liquid receipt token; check the unbonding delay before staking.`,
      `Use the receipt token once in a lending or liquidity pool on ${chain} (${gas(3, 8)}) so the stake is productive, not idle.`,
      `Hold the stake for at least 4 weeks and top up once with $20–$50 (${gas(3, 8)}) if the protocol allows it.`,
      `Exit by unstaking after the delay ends and withdrawing to your wallet (${gas(5, 12)}, time depends on the unbonding period).`,
    ];
    return { steps, costUsd: 55 };
  }
  if (cat === 'Chain') {
    const steps = [
      `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
      `Make a first transaction on ${chain} through ${name}'s main app (${gas(1, 5)}, 5 min): a swap, a deposit or a transfer.`,
      `Use a second app on ${chain} once a week for 4 weeks (${gas(2, 6)} each) so the wallet shows repeated chain use, not one transaction.`,
      `Hold a small balance on ${chain} for the whole month and keep a note of every transaction hash.`,
      `Withdraw what is left to your main wallet when done (${gas(3, 8)}, 10 min).`,
    ];
    return { steps, costUsd: 45 };
  }
  if (cat === 'CEX') {
    const steps = [
      `Open or use an account on ${name} and complete its checks; never pay anyone for an account or for 'early access'.`,
      `Trade ${amt} of spot volume across 2–3 pairs over 2 weeks (fees about 0.1% per trade), keeping the trade history.`,
      `Try one more product ${name} offers, such as a simple earn or convert feature, with $20–$50, and keep the receipt.`,
      `Keep the account active weekly for a month rather than trading everything in one day; a single burst reads as wash volume.`,
      `Withdraw the balance to your own wallet when done and keep the withdrawal record.`,
    ];
    return { steps, costUsd: 30 };
  }
  // Generic fallback: any other category.
  const steps = [
    `Bridge ${amt} of stablecoins to ${chain} through the chain's official bridge (${gas(3, 12)}, 10–25 min) and keep the receipt hash for the record.`,
    `Use ${name} on ${chain} once with ${size}: deposit, swap or stake, whichever its front page offers first (${gas(2, 8)}, 5–10 min).`,
    `Repeat the same action once a week for 4 weeks (${gas(2, 8)} each) so the position ages instead of looking like a single-day visit.`,
    `Keep a note of every transaction hash and any receipt token you hold; check the position weekly.`,
    `Exit by reversing the action and withdrawing to your wallet (${gas(5, 12)}, 10 min).`,
  ];
  return { steps, costUsd: 50 };
}

function tradedPlan(p: Protocol): Plan {
  const chain = chainOf(p);
  const steps = [
    `${p.name}'s token already trades, so there is no pre-token farm here; check its price and market cap on a tracker before acting, and never pay for an 'airdrop list'.`,
    `If you want exposure, buy a small position on a decentralised exchange on ${chain} (~$3–$10 in gas) instead of chasing a future launch that already happened.`,
    `Do not pay for 'early access', 'whitelist' or 'airdrop' offers for this protocol; its launch already happened and anyone selling one is selling nothing.`,
  ];
  return { steps, costUsd: 0 };
}

// ---------------------------------------------------------------- board

export interface BuildOptions {
  variant: 'A' | 'B' | 'C';
}

function verdictFor(implied: number, farmMin: number, thinMin: number): string {
  if (implied >= farmMin) return 'FARM';
  if (implied >= thinMin) return 'THIN';
  return 'SKIP';
}

export function buildBoard(snapshot: Snapshot, opts: BuildOptions): { rows: BoardRow[]; meta: BoardMeta } {
  const asOf = snapshot.as_of;
  const watch = new Set(snapshot.watchlist);
  const comps = cleanComps(snapshot.protocols);
  const engine = fitEngine(comps);
  const oddsModel = fitOdds(snapshot.protocols, asOf);

  // Walk-forward validation, computed live: fit on the oldest half of the
  // dated cleaned comps, test on the newest half.
  const dated = comps.filter((p) => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wfFit = fitEngine(dated.slice(0, half));
  const wfErrs: number[] = [];
  for (const p of dated.slice(half)) {
    const pred = launchValue(wfFit, p);
    wfErrs.push(Math.abs(Math.log10(p.mcap_usd!) - Math.log10(Math.max(pred, 1))));
  }
  const wfMedian = median(wfErrs);

  // Odds validation: 5-fold random CV AUC / log-loss on the peer record.
  const oddsCv = oddsCvScore(snapshot.protocols, asOf);

  const useOdds = opts.variant !== 'A';
  const useRanges = opts.variant === 'C';
  const farmMin = useOdds ? FARM_MIN : FARM_MIN_LAUNCH;
  const thinMin = useOdds ? THIN_MIN : THIN_MIN_LAUNCH;

  // Bootstrap rank ranges (variant C): 50 seeded refits of the engine.
  let ranges = new Map<string, [number, number]>();
  if (useRanges) {
    ranges = bootstrapRanges(snapshot.protocols, comps, engine, oddsModel, asOf, useOdds);
  }

  const rows: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    const traded = p.mcap_usd !== null && p.mcap_usd !== undefined;
    const launch = traded ? p.mcap_usd! : launchValue(engine, p);
    // Variant A ranks by launch value alone: no odds are stored or shown.
    const odds = traded || !useOdds ? null : oddsOf(oddsModel, p, asOf);
    // 15 traded protocols record a market cap of 0 (dead tokens). The gate
    // needs a positive implied value, so they sit at the $1 floor; the
    // recorded 0 is kept in recordedMcapUsd and shown as such.
    const implied = traded ? Math.max(1, Math.round(p.mcap_usd!)) : Math.max(1, Math.round(launch * (useOdds ? odds! : 1)));
    const flag = traded ? null : excludedProduct(p);
    let plan: Plan;
    let verdict: string;
    if (traded) {
      plan = tradedPlan(p);
      verdict = 'TRADED';
    } else {
      plan = planFor(p, implied, farmMin, thinMin);
      verdict = verdictFor(implied, farmMin, thinMin);
    }
    const row: BoardRow = {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'None',
      chains: p.chains,
      tvlUsd: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageDays(p, asOf),
      watchlist: watch.has(p.slug),
      traded,
      flag,
      launchUsd: launch,
      odds,
      impliedUsd: implied,
      recordedMcapUsd: traded ? p.mcap_usd! : null,
      rank: 0,
      preRank: null,
      farmRank: null,
      verdict,
      farmCostUsd: plan.costUsd,
      farmSteps: plan.steps,
      rankLo: null,
      rankHi: null,
      implied_value_usd: implied,
      farm_steps: plan.steps,
    };
    rows.push(row);
  }

  // Global rank by value (gate: ranks 1..N, values non-increasing).
  const byValue = [...rows].sort((a, b) => b.impliedUsd - a.impliedUsd || (a.slug < b.slug ? -1 : 1));
  byValue.forEach((r, i) => {
    r.rank = i + 1;
  });
  // Pre-token rank by implied value.
  const pre = rows.filter((r) => !r.traded).sort((a, b) => b.impliedUsd - a.impliedUsd || (a.slug < b.slug ? -1 : 1));
  pre.forEach((r, i) => {
    r.preRank = i + 1;
    const rg = ranges.get(r.slug);
    if (rg) {
      r.rankLo = rg[0];
      r.rankHi = rg[1];
    }
  });
  // Farmable rank: the headline board is the pre-token rows that are NOT
  // flagged products of a traded token (a CEX, a bridge, a versioned market
  // of a protocol that already trades). Their fitted value is still in the
  // board, but ranking Binance-the-exchange as the #1 farm would be wrong:
  // its TVL is exchange reserves, not DeFi TVL, and the comps curve does not
  // apply to it. Flagged rows keep their pre-token rank and are listed in
  // their own section of the dashboard.
  const farmable = pre.filter((r) => r.flag === null);
  farmable.forEach((r, i) => {
    r.farmRank = i + 1;
  });

  const verdicts = { farm: 0, thin: 0, skip: 0, traded: 0 };
  for (const r of rows) {
    if (r.verdict === 'FARM') verdicts.farm++;
    else if (r.verdict === 'THIN') verdicts.thin++;
    else if (r.verdict === 'SKIP') verdicts.skip++;
    else verdicts.traded++;
  }
  const nExcluded = rows.filter((r) => r.flag !== null).length;
  const meta: BoardMeta = {
    asOf,
    variant: opts.variant,
    nProtocols: rows.length,
    nPreToken: rows.filter((r) => !r.traded).length,
    nFarmable: farmable.length,
    nTraded: rows.filter((r) => r.traded).length,
    nWatchlist: snapshot.watchlist.length,
    nExcluded,
    fit: {
      nComps: comps.length,
      curveA: engine.curveA,
      curveB: engine.curveB,
      c7Intercept: engine.c7Int,
      c7Slope: engine.c7Slope,
      oddsAuc: oddsCv.auc,
      oddsLogloss: oddsCv.logloss,
      oddsBeta: oddsModel.beta,
      walkForward: {
        nFit: half,
        nTest: dated.length - half,
        medianErr: wfMedian,
        factor: 10 ** wfMedian,
      },
    },
    verdicts,
  };
  return { rows, meta };
}

function bootstrapRanges(
  protocols: Protocol[],
  comps: Protocol[],
  _engine: Engine,
  oddsModel: OddsModel,
  asOf: string,
  useOdds: boolean,
): Map<string, [number, number]> {
  const rand = mulberry32(20261121);
  const pre = protocols.filter((p) => p.mcap_usd === null || p.mcap_usd === undefined);
  const ranks = new Map<string, number[]>();
  for (const p of pre) ranks.set(p.slug, []);
  for (let rep = 0; rep < 50; rep++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rand() * comps.length)]!);
    const eng = fitEngine(sample);
    const scored = pre.map((p) => {
      const launch = launchValue(eng, p);
      const odds = oddsOf(oddsModel, p, asOf);
      return { slug: p.slug, v: Math.max(1, Math.round(launch * (useOdds ? odds : 1))) };
    });
    scored.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
  }
  const out = new Map<string, [number, number]>();
  for (const [slug, rs] of ranks) {
    rs.sort((a, b) => a - b);
    const lo = rs[Math.floor(0.1 * (rs.length - 1))]!;
    const hi = rs[Math.floor(0.9 * (rs.length - 1))]!;
    out.set(slug, [lo, hi]);
  }
  return out;
}

function oddsCvScore(protocols: Protocol[], asOf: string): { auc: number; logloss: number } {
  // 5-fold random CV with a fixed seed (deterministic): same split every run.
  const rand = mulberry32(777);
  const idx = protocols.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = t;
  }
  const folds: number[][] = [[], [], [], [], []];
  idx.forEach((v, i) => folds[i % 5]!.push(v));
  const aucs: number[] = [];
  const lls: number[] = [];
  for (let f = 0; f < 5; f++) {
    const te = folds[f]!;
    const tr = folds.flatMap((fo, j) => (j === f ? [] : fo));
    const train = tr.map((i) => protocols[i]!);
    const model = fitOdds(train, asOf);
    const ps = te.map((i) => oddsOf(model, protocols[i]!, asOf));
    const ys = te.map((i) => (protocols[i]!.mcap_usd !== null && protocols[i]!.mcap_usd !== undefined ? 1 : 0));
    let wins = 0;
    let pairs = 0;
    for (let a = 0; a < ps.length; a++) {
      for (let b = 0; b < ps.length; b++) {
        if (ys[a] === 1 && ys[b] === 0) {
          pairs++;
          if (ps[a]! > ps[b]!) wins++;
          else if (ps[a]! === ps[b]!) wins += 0.5;
        }
      }
    }
    aucs.push(pairs === 0 ? 0.5 : wins / pairs);
    let ll = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = Math.min(0.999999999, Math.max(0.000000001, ps[i]!));
      ll += ys[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
    }
    lls.push(ll / ps.length);
  }
  return { auc: aucs.reduce((s, v) => s + v, 0) / aucs.length, logloss: lls.reduce((s, v) => s + v, 0) / lls.length };
}

/** The dashboard's data file: one global the page reads, no network. */
export function dataScript(rows: BoardRow[], meta: BoardMeta): string {
  const slim = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl: r.tvlUsd,
    c7: r.change7d,
    age: r.ageDays,
    wl: r.watchlist ? 1 : 0,
    traded: r.traded ? 1 : 0,
    flag: r.flag,
    launch: r.launchUsd,
    odds: r.odds,
    implied: r.impliedUsd,
    mcap: r.recordedMcapUsd,
    rank: r.rank,
    pre: r.preRank,
    farm: r.farmRank,
    verdict: r.verdict,
    cost: r.farmCostUsd,
    steps: r.farmSteps,
    lo: r.rankLo,
    hi: r.rankHi,
  }));
  return `window.TOKEN_RADAR = ${JSON.stringify({ meta, rows: slim })};\n`;
}

/** The gate's own rules, as a self-check: returns the first failing row, or null. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board: ${rows.length} rows, need 100-4000`;
  // The gate reads the board in rank order, so check it that way too.
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  const seen = new Set<string>();
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const ranks: number[] = [];
  let prev = Number.POSITIVE_INFINITY;
  for (const r of byRank) {
    if (!slugs.has(r.slug)) return `board: ${r.slug} is not in the snapshot`;
    if (seen.has(r.slug)) return `board: ${r.slug} twice`;
    seen.add(r.slug);
    if (!r.name) return `board: ${r.slug} has no name`;
    if (!Number.isInteger(r.rank) || r.rank < 1) return `board: ${r.slug} rank ${r.rank}`;
    ranks.push(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 100_000_000_000_000) {
      return `board: ${r.slug} implied value ${r.implied_value_usd}`;
    }
    if (r.implied_value_usd > prev) return `board: values rise at rank ${r.rank}`;
    prev = r.implied_value_usd;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `board: ${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim().length;
      if (t < 20 || t > 600) return `board: ${r.slug} farm step of ${t} chars`;
    }
  }
  ranks.sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `board: ranks are not 1..N (missing ${i + 1})`;
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length >= 2 && values.size === 1) return 'board: all implied values are the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `board: watchlist ${slug} is missing`;
  }
  return null;
}
