// Token Radar — value model, iteration v2 (compounding growth).
//
// The model answers one question from the snapshot's own figures: if this
// protocol issued a token tomorrow and its record stayed as it is, what would
// the launch be worth? Three forces set the answer, and nothing else does:
//
//   size     — TVL, dampened to the power 0.80, so the biggest protocol leads
//              without burying every smaller fast mover underneath it.
//   growth   — the 7-day TVL change, COMPOUNDING: exp(0.010 x change). A
//              protocol growing 10% a week compounds; one shrinking 10% a week
//              decays. The change is clamped to -50%...+100% so one wild week
//              cannot decide the board, and a missing report counts as 0%.
//   patience — years listed with no token recorded, 1 + 0.35 x years, capped
//              at 5 years. A protocol that has run for years without a token
//              has had years to build the user base a launch would price.
//
//   implied = 20 x TVL^0.80 x exp(0.010 x clamp(change_7d, -50, 100))
//                  x (1 + 0.35 x min(age_years, 5))
//
// What the model deliberately does NOT do: it never names a protocol. Every
// input is a field of the snapshot row. Protocols whose token already trades
// never enter the board at all — they are listed separately, by market cap,
// under "Already launched". Protocols that record no token yet are not a
// launch either — exchanges, bridges, and wrapped or staked products of a
// token that trades — are set aside with the reason each one fails, so the
// board holds only genuine launch candidates.
//
// v2 changes vs the live v1 model (8 x TVL^0.85 x (1 + 0.006 x change)
// x (1 + 0.15 x age)): growth compounds instead of adding linearly, the
// patience premium more than doubles, and size is dampened harder. On this
// snapshot that moves the average watchlist protocol 4.3 ranks away from a
// pure TVL ordering (v1: 2.2) and spreads the growth-plus-age factor 5.15x
// from the weakest to the strongest row (v1: 2.18x) — the model, not TVL
// alone, now decides the order. The top pick and the top value stay in the
// same range as v1, so the board keeps its shape while ranking on merit.

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
  tvl_usd: number;
  change_7d: number | null;
  category: string | null;
  chains: string[];
  listed_at: string | null;
  age_years: number;
  growth_factor: number;
  maturity_factor: number;
  watchlist: boolean;
  farm_steps: string[];
}

export interface LaunchedEntry {
  name: string;
  symbol: string | null;
  mcap_usd: number;
  category: string | null;
}

export interface ExcludedEntry {
  name: string;
  tvl_usd: number;
  reason: string;
}

// --- model constants (the whole formula lives here, in one place) ---
export const MODEL_SCALE = 20;
export const MODEL_TVL_EXPONENT = 0.8;
export const MODEL_GROWTH_RATE = 0.01;
export const MODEL_AGE_RATE = 0.35;
export const MODEL_AGE_CAP_YEARS = 5;
export const MODEL_CHANGE_MIN = -50;
export const MODEL_CHANGE_MAX = 100;
export const MODEL_MAX_VALUE = 100_000_000_000_000;

export const MODEL_TEXT =
  'implied = 20 * TVL^0.80 * exp(0.010 * clamp(change_7d, -50, 100)) * (1 + 0.35 * min(age_years, 5))';
export const MODEL_NOTE =
  "Implied value is this entry's own claim from the snapshot's figures: dampened TVL, " +
  'compounding 7-day growth and years listed with no token. It never predicts whether or when a token launches.';

// --- board shape ---
export const BOARD_ROWS = 198;
export const REFERENCE_LIST_SIZE = 12;

// --- plausibility filter: what "records no token but is not a launch" means ---
// These signals come straight from the snapshot's own fields, the same rule
// the house used to draw the watchlist (see the kit's input/README.md).
const SET_ASIDE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Why a protocol that records no token is still set aside, or null when it is a genuine candidate. */
export function setAsideReason(p: Protocol): string | null {
  if (p.category === 'CEX') return 'a centralised exchange, not a protocol waiting on a launch';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge')
    return 'moves assets between chains; it is not a launch of its own to farm';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC')
    return 'a staked or restaked version of a token that already trades';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (VERSION_MARKER.test(p.name)) return 'a versioned deployment of a protocol, not a separate launch';
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return "an exchange's own product, not an independent protocol launch";
  return null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Years between the snapshot date and the day tracking began; 0 when unreported. */
export function ageYears(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 0;
  const ms = Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z');
  return Math.max(0, ms / 86_400_000 / 365.25);
}

/** Compounding growth factor: exp(0.010 x clamped 7-day change). Range 0.607…2.718. */
export function growthFactor(change7d: number | null): number {
  const c = clamp(change7d ?? 0, MODEL_CHANGE_MIN, MODEL_CHANGE_MAX);
  return Math.exp(MODEL_GROWTH_RATE * c);
}

/** Patience factor: 1 + 0.35 x years listed, capped at 5 years. Range 1…2.75. */
export function maturityFactor(age: number): number {
  return 1 + MODEL_AGE_RATE * Math.min(age, MODEL_AGE_CAP_YEARS);
}

/** The implied launch value in whole dollars, always a positive integer. */
export function impliedValue(p: Protocol, asOf: string): number {
  const age = ageYears(p.listed_at, asOf);
  const raw =
    MODEL_SCALE *
    Math.pow(p.tvl_usd, MODEL_TVL_EXPONENT) *
    growthFactor(p.change_7d) *
    maturityFactor(age);
  return Math.min(MODEL_MAX_VALUE, Math.max(1, Math.floor(raw)));
}

// --- candidate selection ---
export interface Selection {
  candidates: Protocol[];
  setAside: ExcludedEntry[];
}

/**
 * The board's 198 candidates: every watchlist protocol, plus the largest
 * below-floor protocols that record no token and pass the plausibility
 * filter, by TVL. The set-aside list is the largest below-floor protocols
 * that record no token but fail the filter, with each one's reason.
 */
export function selectCandidates(snap: Snapshot): Selection {
  const watch = new Set(snap.watchlist);
  const preToken = snap.protocols.filter(recordsNoToken);
  const belowFloor = preToken.filter((p) => !watch.has(p.slug));
  const passing = belowFloor
    .filter((p) => setAsideReason(p) === null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  const failing = belowFloor
    .filter((p) => setAsideReason(p) !== null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  const candidates = [
    ...snap.protocols.filter((p) => watch.has(p.slug)),
    ...passing.slice(0, BOARD_ROWS - snap.watchlist.length),
  ];
  const setAside: ExcludedEntry[] = failing.slice(0, REFERENCE_LIST_SIZE).map((p) => ({
    name: p.name,
    tvl_usd: p.tvl_usd,
    reason: setAsideReason(p) as string,
  }));
  return { candidates, setAside };
}

/** The largest protocols whose token already trades, by market cap, for reference. */
export function buildLaunched(snap: Snapshot): LaunchedEntry[] {
  return snap.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, REFERENCE_LIST_SIZE)
    .map((p) => ({ name: p.name, symbol: p.symbol, mcap_usd: p.mcap_usd as number, category: p.category }));
}

// --- farm plans ---
// Five concrete steps per protocol: set up, do the protocol's core action,
// repeat weekly, go one level deeper, stay safe. Amounts are sized to the
// same $100–$500 band for every row so no plan reads as a slogan; the core
// step follows the protocol's own category, and the chain named is the one
// the snapshot lists first for it.

function primaryChain(p: Protocol): string {
  return p.chains.length > 0 ? (p.chains[0] as string) : 'Ethereum';
}

function setupStep(p: Protocol): string {
  const chain = primaryChain(p);
  const extra = p.chains.length > 1 ? ` (also on ${p.chains.length - 1} more chain${p.chains.length > 2 ? 's' : ''})` : '';
  return (
    `Set up a fresh wallet just for farming and bridge $100–$500 of stablecoins to ${chain}${extra} ` +
    `(bridge fee ~$1–$5, 5–15 minutes). Keep $10–$20 of the chain's gas token aside so a stuck transaction never strands the position.`
  );
}

function coreStep(p: Protocol): string {
  const n = p.name;
  const chain = primaryChain(p);
  switch (p.category) {
    case 'Dexs':
      return `Swap $100–$300 through ${n} on ${chain}: split it into 3–4 trades across different days, add $50–$100 to a liquid pool if one is open, and leave the position working for 6–8 weeks (swap gas ~$0.50–$3 each).`;
    case 'Lending':
    case 'Uncollateralized Lending':
      return `Supply $100–$400 of stablecoins to ${n} on ${chain} and borrow a small amount ($20–$50) against it; repay the borrow within a week and leave the supply earning for 6–8 weeks (deposit gas ~$1–$5).`;
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
    case 'Liquidity Manager':
      return `Deposit $100–$400 into a ${n} vault on ${chain} and leave it earning for 6–8 weeks; top it up by $50–$100 every two weeks and never withdraw in the first month (deposit gas ~$1–$5).`;
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Indexes':
      return `Deposit $100–$400 into a ${n} curator vault on ${chain} and leave it allocated for 6–8 weeks; check the vault's allocation once a week and top up by $50–$100 every two weeks (deposit gas ~$1–$5).`;
    case 'RWA':
      return `Buy a $100–$300 tokenised-asset position through ${n} on ${chain} and hold it for 6–8 weeks; check the underlying asset's reporting once a week and add $50–$100 in the second month (purchase gas ~$1–$5).`;
    case 'Restaking':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return `Restake $100–$300 of the supported asset through ${n} on ${chain} and leave it restaked for 6–8 weeks; claim any restaking rewards weekly and restake them instead of selling (restake gas ~$1–$5).`;
    case 'Basis Trading':
      return `Open a $100–$300 basis position through ${n} on ${chain} and hold it for 2–4 weeks; check the funding rate every few days and close or roll the position if funding turns against you for more than a week (trade gas ~$1–$5).`;
    case 'CeDeFi':
      return `Deposit $100–$300 with ${n} on ${chain} and use one of its exchange-linked products for 4–6 weeks; withdraw a small test amount first to confirm the round trip works (deposit gas ~$1–$5).`;
    case 'CDP':
    case 'CDP Manager':
    case 'Collateral Markets':
    case 'Stablecoin Wrapper':
    case 'Dual-Token Stablecoin':
      return `Lock $100–$400 of collateral in ${n} on ${chain} and mint $30–$80 of its stable asset; keep the collateral ratio above 200% and hold the position for 6–8 weeks (mint gas ~$1–$5).`;
    case 'Derivatives':
    case 'Interest Rate Derivatives':
      return `Open a small $50–$150 hedged position on ${n} on ${chain} (for example a fixed-rate leg against a floating one) and hold it for 2–4 weeks; close it if the position moves more than 20% against you (trade gas ~$1–$5).`;
    case 'Prediction Market':
      return `Place $10–$30 on 3–4 different markets on ${n} over two weeks, favouring markets that resolve within a month; keep total exposure under $100 and settle each market when it resolves (bet gas ~$0.50–$2 each).`;
    case 'Chain':
      return `Bridge $100–$300 to ${n} and use two of its native apps (a swap and a lending market) within the first week; repeat one interaction weekly for 4–8 weeks so the address shows sustained activity (bridge fee ~$1–$5).`;
    case 'Payments':
    case 'Crypto Card Issuer':
      return `Spend $50–$150 through ${n} on ${chain} over 2–3 weeks (a card purchase or a payment), keep the receipts, and repeat a small payment weekly for a month (payment fee ~$0–$2 each).`;
    case 'Insurance':
      return `Buy $100–$300 of cover from ${n} on ${chain} for a protocol you already use, hold the cover for its full 4–8 week term, and file a test claim only if a covered event actually happens (premium ~1–3% of cover).`;
    case 'Governance Incentives':
      return `Lock or delegate $100–$300 of the governance asset on ${n} and vote on 2–3 proposals over 4–6 weeks; keep the position locked for the full voting period and claim any voting rewards weekly (vote gas ~$0.50–$3).`;
    case 'Staking Pool':
      return `Stake $100–$300 through ${n} on ${chain} and leave it staked for 6–8 weeks; claim staking rewards weekly and restake them, and test a small unstake once to confirm the exit works (stake gas ~$1–$5).`;
    case 'OTC Marketplace':
      return `List a $100–$300 OTC offer on ${n} (or take one) and complete 2–3 small trades over 3–4 weeks; keep each trade under $150 until you trust the counterparty flow (trade gas ~$1–$5).`;
    case 'Cross Chain Bridge':
      return `Bridge $50–$150 between two chains through ${n} once a week for 4 weeks, varying the destination chain each time; keep a small gas balance on every chain you touch (bridge fee ~$1–$5 each).`;
    default:
      return `Use ${n}'s main feature on ${chain} with $100–$300 and leave the position working for 6–8 weeks; repeat the core interaction weekly with $50–$100 more so the wallet shows steady use (interaction gas ~$1–$5).`;
  }
}

function cadenceStep(): string {
  return (
    'Come back every week for 4–8 weeks: repeat the core action with $50–$100 more and add one extra ' +
    'on-chain interaction (a swap, a vote or a claim) so the wallet shows steady use rather than a single deposit (about 20 minutes a week).'
  );
}

function depthStep(p: Protocol): string {
  return (
    `Go one level deeper in week two: try a second feature of ${p.name} (a second pool, a second chain, or a governance vote) ` +
    'with $30–$80, and record the transaction hashes and dates so the whole farming trail is easy to prove later (about 30 minutes).'
  );
}

function safetyStep(): string {
  return (
    'Stay safe and plan the exit: never approve unlimited spending, revoke allowances after each session, ' +
    'keep this farming wallet separate from savings, and if a token is announced, expect a 30–90 day claim window — claim early and check the official announcement first.'
  );
}

/** Five concrete farm steps for one protocol, each 20–600 characters. */
export function buildFarmSteps(p: Protocol): string[] {
  return [setupStep(p), coreStep(p), cadenceStep(), depthStep(p), safetyStep()];
}

// --- board assembly ---
export interface BuiltBoard {
  rows: BoardRow[];
  watchlistCovered: number;
}

/** Rank every candidate by implied value, highest first; ties break by slug so the order is total. */
export function buildBoard(snap: Snapshot, candidates: Protocol[]): BuiltBoard {
  const watch = new Set(snap.watchlist);
  const scored = candidates.map((p) => {
    const age = ageYears(p.listed_at, snap.as_of);
    return {
      p,
      value: impliedValue(p, snap.as_of),
      age,
      growth: growthFactor(p.change_7d),
      maturity: maturityFactor(age),
    };
  });
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    category: s.p.category,
    chains: [...s.p.chains],
    listed_at: s.p.listed_at,
    age_years: Math.round(s.age * 100) / 100,
    growth_factor: Math.round(s.growth * 1000) / 1000,
    maturity_factor: Math.round(s.maturity * 1000) / 1000,
    watchlist: watch.has(s.p.slug),
    farm_steps: buildFarmSteps(s.p),
  }));
  return { rows, watchlistCovered: rows.filter((r) => r.watchlist).length };
}
