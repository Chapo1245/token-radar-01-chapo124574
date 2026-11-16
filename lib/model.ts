// lib/model.ts — the value model behind the Launch Radar.
//
// The board ranks protocols that record no token yet by what their launch
// would be worth, using only the sealed snapshot's own figures: TVL, the
// seven-day TVL change, and how long the protocol has run with no token
// recorded. Nothing here names a protocol. Every number below is fitted or
// derived from the snapshot at run time, so the same program re-run on a
// later snapshot would rank that snapshot's protocols, not these.
//
// How the value is worked out, in three layers:
//
//   1. A comparables curve. Protocols whose token already trades give a
//      scale: log10(market cap) regressed on log10(TVL) over the trading
//      protocols that are comparable (exchanges, bridges and staked or
//      wrapped products are left out, because their market cap does not
//      come from protocol TVL in the same way). The curve is fitted on
//      four fifths of those protocols and tested blind on the fifth:
//      the holdout's median error is reported with the fit, honestly,
//      even though it is wide. The curve anchors the scale only.
//   2. A power law in TVL. The curve's slope is shallow (about 0.39),
//      so ranking on the curve alone barely separates a $5M protocol
//      from a $2B one. The ranking shape is TVL^0.80, and its constant K
//      is chosen so the model's median, at neutral growth and age,
//      equals the comparables curve's median prediction over the board.
//      The scale is the market's; the shape is the radar's.
//   3. Growth and age. A protocol whose TVL grew in the last seven days
//      is worth more than one whose TVL shrank, and a protocol that has
//      run for years with no token recorded is worth more than one
//      listed last month. Both factors are clamped so a single wild week
//      cannot crown a protocol on its own.
//
// The board itself holds only radar-eligible protocols: pre-token, and
// not a wrapped, staked or bridged product of a token that already
// trades, not an exchange, not a bridge or liquid-staking category, and
// not a versioned copy. That is the house watchlist's own rule, applied
// to the whole snapshot instead of only its $50M floor, which is how the
// board finds early protocols below the floor. Every watchlist slug is
// forced onto the board even if the rule would leave it out.

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

/** The fitted comparables curve and its blind test. */
export interface CompsFit {
  /** Intercept of log10(mcap) = intercept + slope * log10(TVL), all comparables. */
  intercept: number;
  /** Slope of the same fit. */
  slope: number;
  /** R squared of the fit on all comparables. */
  r2: number;
  /** How many trading protocols the fit used. */
  n: number;
  /** How many protocols the blind holdout held. */
  holdoutN: number;
  /** Median absolute log10 error on the holdout. */
  holdoutMedianLogErr: number;
  /** The same error as a plain factor (10 ^ median log error). */
  holdoutFactor: number;
}

/** Categories whose market cap is not comparable to a protocol's TVL. */
const NON_COMPARABLE = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names: a protocol beginning with one is the exchange itself. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker, such as "V2" or "2.0". */
const VERSION_SUFFIX = /\s(v\d+|V\d+|\d+\.\d+)$/;

/** A whole word that marks a wrapped, staked or staking product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A protocol records no token when both token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is a genuine launch candidate: it records no token,
 * and it is not a wrapped, staked or bridged product of a token that
 * already trades, not an exchange, and not a versioned copy. This mirrors
 * the snapshot's own watchlist rule, without its $50M floor.
 */
export function isRadarEligible(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && NON_COMPARABLE.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** Years between the snapshot date and the day tracking began, 0 when unknown. */
export function yearsListed(p: SnapshotProtocol, asOf: string): number {
  if (p.listed_at === null) return 0;
  const start = Date.parse(`${p.listed_at}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 86400000 / 365.25;
}

/** A small deterministic hash: the holdout split must not move between runs. */
function slugHash(slug: string): number {
  let h = 7;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Ordinary least squares for log10(mcap) on log10(TVL). */
function ols(rows: SnapshotProtocol[]): { intercept: number; slope: number; r2: number } {
  const xs = rows.map((p) => Math.log10(p.tvl_usd));
  const ys = rows.map((p) => Math.log10(p.mcap_usd as number));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] as number - meanX) * (ys[i] as number - meanY);
    sxx += (xs[i] as number - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    ssTot += (ys[i] as number - meanY) ** 2;
    ssRes += (ys[i] as number - (intercept + slope * (xs[i] as number))) ** 2;
  }
  return { intercept, slope, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/**
 * Fit the comparables curve on the trading protocols that are comparable
 * (a market cap recorded, and not in a non-comparable category), then test
 * it blind: every fifth protocol by slug hash is held out, the curve is
 * fitted on the rest, and the holdout's median error is reported.
 */
export function fitComps(protocols: SnapshotProtocol[]): CompsFit {
  const comps = protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && (p.category === null || !NON_COMPARABLE.has(p.category)),
  );
  const train = comps.filter((p) => slugHash(p.slug) % 5 !== 0);
  const holdout = comps.filter((p) => slugHash(p.slug) % 5 === 0);
  const all = ols(comps);
  const trained = ols(train.length > 0 ? train : comps);
  const errors = holdout
    .map((p) => Math.abs(Math.log10(p.mcap_usd as number) - (trained.intercept + trained.slope * Math.log10(p.tvl_usd))))
    .sort((a, b) => a - b);
  const medianErr = errors.length === 0 ? 0 : (errors[Math.floor(errors.length / 2)] as number);
  return {
    intercept: all.intercept,
    slope: all.slope,
    r2: all.r2,
    n: comps.length,
    holdoutN: holdout.length,
    holdoutMedianLogErr: medianErr,
    holdoutFactor: Math.pow(10, medianErr),
  };
}

/** What the comparables curve predicts for one protocol's TVL. */
export function compsPrediction(p: SnapshotProtocol, fit: CompsFit): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(p.tvl_usd));
}

/**
 * The anchor constant K: the median comparables prediction over the board
 * divided by the median TVL^0.80 over the same board, so the model's
 * median at neutral growth and age equals the market curve's median.
 */
export function anchorConstant(board: SnapshotProtocol[], fit: CompsFit): number {
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] as number;
  };
  const medComps = median(board.map((p) => compsPrediction(p, fit)));
  const medPow = median(board.map((p) => Math.pow(p.tvl_usd, 0.8)));
  return medPow === 0 ? 0 : medComps / medPow;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * The implied launch value, in dollars:
 *   implied = K * TVL^0.80 * (1 + 1.5 * clamp(change_7d, -50, +60) / 100)
 *                          * (1 + 0.45 * min(years listed with no token, 5))
 * K is the comparables anchor for this snapshot. The growth factor is
 * linear and clamped, so a single wild week (a 4,400% spike is in the
 * snapshot) can add at most 90% and can cut at most 75%; the age factor
 * tops out at 3.25x for five years with no token recorded.
 */
export function impliedValue(p: SnapshotProtocol, asOf: string, anchorK: number): number {
  const growth = 1 + 1.5 * (clamp(p.change_7d ?? 0, -50, 60) / 100);
  const age = 1 + 0.45 * Math.min(yearsListed(p, asOf), 5);
  return anchorK * Math.pow(p.tvl_usd, 0.8) * growth * age;
}

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/**
 * The net verdict on a farm plan, from the implied value and the week's
 * TVL move. FARM means the implied value clears $50M while TVL is steady
 * or growing; THIN means the value is real but modest; SKIP means the
 * value is low or TVL is falling fast enough that the farm's time costs
 * more than it is likely to return.
 */
export function verdictFor(impliedUsd: number, change7d: number | null): Verdict {
  const change = change7d ?? 0;
  if (impliedUsd >= 50_000_000 && change >= -10) return 'FARM';
  if (impliedUsd >= 10_000_000 && change >= -30) return 'THIN';
  return 'SKIP';
}

export interface FarmCost {
  /** Bridge and transaction gas, in dollars. */
  gasUsd: number;
  /** Working capital the plan deploys, in dollars. */
  capitalUsd: number;
  /** Hours of the reader's time over the whole plan. */
  hours: number;
}

/** What a farm of this protocol costs: gas grows with chain count, capital with TVL. */
export function farmCost(p: SnapshotProtocol): FarmCost {
  const chains = Math.min(p.chains.length, 8);
  return {
    gasUsd: Math.round(2 + chains * 1.5),
    capitalUsd: Math.round(150 + Math.min(400, (p.tvl_usd / 1_000_000) * 0.5)),
    hours: Math.round((3 + chains * 0.25) * 10) / 10,
  };
}

/** The core action a farm takes, by category; the fallback fits anything else. */
const CORE_ACTION: Record<string, string> = {
  Lending: 'supply stablecoins to the lending pools and borrow a small amount against them',
  Dexs: 'swap between the pools and add a small amount of liquidity to one pair',
  'Yield Aggregator': 'deposit stablecoins into a yield vault and leave the position working',
  Yield: 'deposit stablecoins into the yield vaults and leave the position working',
  'Risk Curators': 'deposit into a curator vault and leave the allocation in place',
  'Onchain Capital Allocator': 'deposit into an allocator vault and leave the allocation in place',
  CDP: 'open a collateralised debt position with a small amount of collateral and mint against it',
  'CDP Manager': 'open a managed collateralised debt position with a small amount of collateral',
  'Prediction Market': 'take positions in the live markets that are closest to resolving',
  RWA: 'buy a small position in the tokenised real-world-asset pools on offer',
  Derivatives: 'open a small hedged position in the derivatives markets',
  Restaking: 'restake a small amount and keep the position delegated',
  'Collateral Markets': 'supply collateral to the markets and borrow a small amount against it',
  'Liquidity Manager': 'deposit into a managed liquidity position on the busiest pool',
  'Cross Chain Bridge': 'bridge a small amount back and forth between the supported chains',
  'Basis Trading': 'deposit into the basis-trading vault and leave the position in place',
  Payments: 'run a few real payments through the protocol so the wallet shows genuine use',
  Insurance: 'buy a small cover policy on the pools you already use',
  Farm: 'deposit into the farm pools and leave the position compounding',
  Indexes: 'buy a small amount of the index token and hold it',
  'Dual-Token Stablecoin': 'mint a small amount of the stablecoin against collateral and hold it',
  'Stablecoin Wrapper': 'wrap a small amount of stablecoins and hold the wrapped token',
  'Interest Rate Derivatives': 'open a small position in the rate markets',
  'Uncollateralized Lending': 'supply a small amount to the lending pools',
  'Leveraged Farming': 'open a small leveraged farming position with tight limits',
  'Governance Incentives': 'vote on the live proposals and stake a small amount behind the votes',
  'Crypto Card Issuer': 'order the card, load it with a small amount, and spend through it',
  'OTC Marketplace': 'place a small order on the marketplace and settle it',
  CeDeFi: 'deposit a small amount into the centralised-DeFi vaults on offer',
  'Staking Pool': 'stake a small amount in the pool and keep it staked',
  'Decentralized BTC': 'deposit a small amount of BTC into the decentralised vaults',
  'Anchor BTC': 'deposit a small amount of BTC into the anchor vaults',
  Chain: 'bridge in, use the chain-native apps for a few transactions, and keep a balance there',
};

function coreAction(p: SnapshotProtocol): string {
  return (p.category !== null && CORE_ACTION[p.category]) || 'use the protocol\u2019s main product with a small position and keep it open';
}

function money(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(v / 1_000)}K`;
}

/**
 * Five concrete farm steps for one protocol, each with what it costs and
 * how long it takes, ending in the net: total cost, total time, and the
 * verdict with its reason. Every step is written from the protocol's own
 * category, chains and numbers, never from a list of names.
 */
export function farmSteps(p: SnapshotProtocol, impliedUsd: number, verdict: Verdict, cost: FarmCost): string[] {
  const mainChain = p.chains[0] ?? 'Ethereum';
  const extraChains = Math.max(0, p.chains.length - 1);
  const chainNote = extraChains > 0 ? ` (also on ${extraChains} more chain${extraChains === 1 ? '' : 's'})` : '';
  const capitalLow = Math.max(50, Math.round(cost.capitalUsd * 0.6));
  const capitalHigh = cost.capitalUsd;
  const reason =
    verdict === 'FARM'
      ? 'implied value clears $50M with 7-day TVL steady or growing, so the farm is worth the cost'
      : verdict === 'THIN'
        ? 'implied value is real but modest, so farm small and only while the gas stays cheap'
        : 'implied value is low or TVL is falling fast, so the farm costs more in time than it is likely to return';
  return [
    `Set up a fresh wallet just for farming and bridge $100–$500 of stablecoins to ${mainChain}${chainNote} — bridge fee about $1–$5, 5–15 minutes. Keep $10–$20 of the chain's gas token aside so a stuck transaction never strands the position.`,
    `Put $${capitalLow}–$${capitalHigh} to work: ${coreAction(p)} (deposit gas about $1–$5) and leave it in place for 6–8 weeks; check the position once a week and top up by $50–$100 every two weeks.`,
    `Come back every week for 4–8 weeks: repeat the core action with $50–$100 more and add one extra on-chain interaction (a swap, a vote or a claim) so the wallet shows steady use rather than a single deposit (about 20 minutes a week).`,
    `Go one level deeper in week two: try a second feature of ${p.name} (a second pool, a second chain, or a governance vote) with $30–$80, and record the transaction hashes and dates so the whole farm is easy to prove later (about 30 minutes).`,
    `Net: about $${cost.gasUsd} in gas and $${cost.capitalUsd} of working capital for 6–8 weeks, roughly ${cost.hours} hours of your time. Implied value ${money(impliedUsd)} — verdict ${verdict}: ${reason}.`,
  ];
}

/** The formula exactly as the dashboard states it, with this run's anchor K. */
export function formulaText(anchorK: number): string {
  return `implied = ${anchorK.toFixed(2)} x TVL^0.80 x (1 + 1.5 x clamp(change_7d, -50, +60) / 100) x (1 + 0.45 x min(age_years, 5))`;
}
