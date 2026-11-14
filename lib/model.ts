// Token Radar — the value model and the farm plans.
//
// Everything here is derived from the snapshot's own fields. No protocol name is
// ever listed: eligibility, value and plans all come from tvl_usd, change_7d,
// listed_at, category, chains and the token fields.

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

/** Why a protocol is not a launch candidate, or null when it is one. */
export function exclusionReason(p: Protocol): string | null {
  if (p.gecko_id !== null || p.symbol !== null) return 'token already trades';
  const deadCategories = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  if (p.category !== null && deadCategories.includes(p.category)) return 'category is ' + p.category;
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(p.name)) return 'versioned name';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped or staked product';
  const exchanges = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
  for (const ex of exchanges) if (p.name.startsWith(ex)) return 'exchange product';
  return null;
}

export function isLaunchCandidate(p: Protocol): boolean {
  return exclusionReason(p) === null;
}

/** Whole years between the snapshot date and the day DefiLlama first listed the protocol. */
export function ageYears(p: Protocol, asOf: string): number {
  if (p.listed_at === null) return 1;
  const listed = Date.parse(p.listed_at + 'T00:00:00Z');
  const now = Date.parse(asOf + 'T00:00:00Z');
  if (!Number.isFinite(listed) || now <= listed) return 0;
  return (now - listed) / (365.25 * 24 * 3600 * 1000);
}

export interface ValueBreakdown {
  implied: number;
  growthFactor: number;
  maturityFactor: number;
  age: number;
  change: number;
}

/**
 * Implied launch value, in whole dollars.
 *
 *   implied = 8 x TVL^0.85 x growth x maturity
 *   growth   = 1 + 0.006 x change_7d, change clamped to [-50, +100] (null counts as 0)
 *   maturity = 1 + 0.15 x min(age_years, 5)
 *
 * TVL is dampened (power 0.85) so a ten-times-larger protocol is worth about seven
 * times more, not ten: size leads, but a smaller protocol that is growing fast can
 * still climb. Growth is the snapshot's own 7-day TVL change. Maturity rewards
 * time spent running with no token — the user base a launch would price.
 */
export function impliedValue(p: Protocol, asOf: string): ValueBreakdown {
  const change = Math.max(-50, Math.min(100, p.change_7d ?? 0));
  const growthFactor = 1 + 0.006 * change;
  const age = ageYears(p, asOf);
  const maturityFactor = 1 + 0.15 * Math.min(age, 5);
  const raw = 8 * Math.pow(p.tvl_usd, 0.85) * growthFactor * maturityFactor;
  return { implied: Math.max(1, Math.floor(raw)), growthFactor, maturityFactor, age, change };
}

function money(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

function chainText(p: Protocol): string {
  if (p.chains.length === 0) return 'its chain';
  if (p.chains.length === 1) return p.chains[0];
  return p.chains[0] + ' (also on ' + (p.chains.length - 1) + ' more chain' + (p.chains.length > 2 ? 's' : '') + ')';
}

/** The core action for a category, as {verb, detail} — the heart of every farm plan. */
function coreAction(p: Protocol): { verb: string; detail: string } {
  const chain = chainText(p);
  switch (p.category) {
    case 'Dexs':
      return { verb: 'Swap and add liquidity', detail: 'Swap $50–$200 through ' + p.name + ' on ' + chain + ' once a week, then add $100–$300 to a core pool and hold the LP position for at least 4 weeks (swap fee ~0.3%, gas ~$0.50–$3 per trade).' };
    case 'Lending':
      return { verb: 'Supply, then borrow against it', detail: 'Supply $200–$500 of a stablecoin or blue-chip asset to ' + p.name + ' on ' + chain + ', then borrow 30–40% of it back and re-supply the loan; keep the health factor above 1.8 and repeat the cycle monthly (gas ~$1–$4 per action).' };
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return { verb: 'Deposit into a curator vault', detail: 'Deposit $100–$400 into a ' + p.name + ' vault on ' + chain + ' and leave it earning for 6–8 weeks; top it up by $50–$100 every two weeks and never withdraw in the first month (deposit gas ~$1–$5).' };
    case 'Yield':
    case 'Yield Aggregator':
      return { verb: 'Deposit into a yield vault', detail: 'Deposit $100–$300 into the highest-TVL ' + p.name + ' vault on ' + chain + ' and auto-compound for 4–6 weeks; harvest or re-deposit the yield weekly (harvest gas ~$0.50–$2 per claim).' };
    case 'RWA':
      return { verb: 'Hold a tokenised real-world position', detail: 'Buy or mint $100–$500 of ' + p.name + "'s tokenised asset on " + chain + ' and hold it for 6–8 weeks so the position accrues yield and a holding history; check the backing report monthly (mint fee varies, usually under 0.5%).' };
    case 'Derivatives':
      return { verb: 'Open small hedged positions', detail: 'Open a $50–$150 perpetual or options position on ' + p.name + ' (' + chain + ') with 2–3x leverage at most, close it within a week, and repeat 2–3 times a month; set a stop-loss and never risk more than $20 per trade.' };
    case 'CDP':
    case 'CDP Manager':
      return { verb: 'Mint stablecoins against collateral', detail: 'Lock $200–$500 of collateral in ' + p.name + ' on ' + chain + ' and mint stablecoins at under 50% of the collateral value; keep the position open for 4–6 weeks and repay a little each week (mint gas ~$1–$5).' };
    case 'Basis Trading':
      return { verb: 'Join a basis / delta-neutral vault', detail: 'Deposit $100–$300 into a ' + p.name + ' basis vault on ' + chain + ' and hold for 4–6 weeks while it earns the funding-rate spread; add $50 every two weeks and review the vault report weekly (deposit gas ~$1–$4).' };
    case 'Prediction Market':
      return { verb: 'Trade live markets weekly', detail: 'Place 2–4 small trades of $5–$25 each on ' + p.name + ' markets on ' + chain + ' every week for a month, across at least two different event types; settle and re-enter rather than holding one bet (fee ~1–2% per trade).' };
    case 'Restaking':
      return { verb: 'Restake and delegate', detail: 'Restake $100–$300 of liquid-staked assets through ' + p.name + ' on ' + chain + ' and delegate to an operator; hold the position for 6–8 weeks and re-delegate only if the operator underperforms (restake gas ~$2–$6).' };
    case 'Liquidity Manager':
      return { verb: 'Deposit into a managed range', detail: 'Deposit $100–$300 into a ' + p.name + ' managed liquidity position on ' + chain + ' and let it rebalance for 4–6 weeks; add $50 monthly and check the range report each week (deposit gas ~$1–$4).' };
    case 'Farm':
    case 'Leveraged Farming':
      return { verb: 'Farm with modest leverage', detail: 'Deposit $100–$250 into a ' + p.name + ' farm on ' + chain + ' at 2x leverage at most, harvest the rewards weekly and re-deposit them for 4–6 weeks; keep leverage low enough to survive a 30% dip (harvest gas ~$1–$3).' };
    default:
      return { verb: 'Use the protocol every week', detail: 'Use ' + p.name + ' on ' + chain + ' at least once a week for a month — a $50–$200 transaction each time, held or staked for 2–4 weeks — so the wallet builds a real usage history instead of a single visit (each action costs ~$0.50–$5 in gas).' };
  }
}

/**
 * A concrete farm plan: 5 steps, each with what it costs and how long it takes.
 * Steps are built from the protocol's own category and chains, so two protocols
 * in the same category share a shape but name different chains and amounts.
 */
export function farmSteps(p: Protocol): string[] {
  const chain = chainText(p);
  const core = coreAction(p);
  const cat = p.category ?? 'DeFi';
  const steps = [
    'Set up a fresh wallet for farming and bridge $100–$500 of stablecoins to ' + chain + ' (bridge fee ~$1–$5, 5–15 minutes), keeping $10–$20 of the chain gas token aside for transactions.',
    core.verb + ': ' + core.detail,
    'Come back every week for 4–8 weeks: repeat the core action with $50–$100 more, and do one extra on-chain interaction (a swap, a vote, or a claim) so the wallet shows steady use, not a single deposit (about 20 minutes a week).',
    'Track the position weekly in ' + p.name + "'s own dashboard on " + chain + ': note the TVL, your deposited amount and any points or season progress, and screenshot the balance once a month as your own record (free, 5 minutes).',
    'Stay safe: never approve unlimited spending (approve only the amount you deposit), never paste your seed phrase anywhere, and exit by withdrawing in two parts over a week if the ' + cat + ' position drops more than 25% or the protocol pauses deposits.',
  ];
  return steps.map((s) => s.trim());
}
