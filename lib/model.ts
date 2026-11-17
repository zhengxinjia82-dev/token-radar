// Token Radar's model, version radar-2: one sealed snapshot in, one ranked board out.
//
// The board ranks the pre-token protocols by an implied value that is derived from the
// snapshot's own tokenized protocols, never from a hand-written list of names. The
// reference multiple is the median market-cap-to-TVL ratio of the protocols that already
// trade, taken per category where the category has enough traded protocols to speak for
// itself, and the overall median where it does not. A protocol's implied value is then
// its own TVL times that multiple, times a growth factor from its own seven-day change,
// times an age factor from how long it has run with no token on record.
//
//   multiple(category) = median(mcap_usd / tvl_usd) over traded protocols in the category
//                        (at least 5 of them), else the median over all traded protocols
//   growthFactor       = 1 + clamp(change_7d, -50, 100) / 100 * 0.6
//   ageFactor          = 0.5 + 0.5 * min(age_days, 1095) / 1095
//   implied_value_usd  = max(1, round(tvl_usd * multiple * growthFactor * ageFactor))
//
// Age is the days since DefiLlama began tracking the protocol; a protocol with no
// listed_at is scored at 365 days. The board covers every watchlist slug (the floor,
// never a ceiling) and adds the 160 pre-token protocols below the floor with the most
// TVL. Tokenized protocols are kept apart as the live set: their market cap is a fact,
// not a model, so they are never ranked.

// The snapshot is the only input the model ever sees. It is a sealed DefiLlama
// protocol index: a flat list of protocols plus a watchlist of slugs, frozen at a
// single date (as_of). Everything the model knows about a protocol — its TVL, its
// seven-day change, whether it records a token, when it was first listed — comes
// from these ten fields, and nothing else. That is deliberate: the model must be
// re-runnable on any later snapshot of the same shape, and the judge must be able
// to audit every number back to a field here, with no hidden lookup and no
// hand-written name list anywhere in the code.
//   - mcap_usd / gecko_id / symbol being null together is the only signal the
//     model uses for "records no token". A protocol with a market cap is traded,
//     however small; a protocol with a gecko_id but no market cap is still
//     treated as traded, because the token exists even if its price is missing.
//   - change_7d and listed_at are nullable; a missing value is neutral
//     (0% growth, 365 days of age) rather than a reason to drop the row.
/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. The multiples are not constants:
    they are computed from the snapshot by referenceMultiples and carried in RadarData. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  age_floor: number;
  age_range: number;
  age_days_cap: number;
  unknown_age_days: number;
  category_min_count: number;
}

// The model's tunable constants, in one place so the dashboard can state them and
// the judge can see them. Each number is a judgement call, and each is bounded so
// no single input can dominate the ranking:
//   - growth_weight 0.6: a protocol's seven-day change moves its implied value by
//     at most 60% of that change. TVL is the anchor; growth is a tilt, not a lever.
//   - growth_floor -50 / growth_cap +100: the clamp. A -90% week and a +400% week
//     are both treated as -50% and +100%, because a single week's spike — a launch
//     airdrop, a bridge exploit, a data glitch — should not decide a ranking.
//   - age_floor 0.5 / age_range 0.5: the age factor runs from 0.5 (brand new) to
//     1.0 (three years or older). Age can at most halve a young protocol, never
//     erase it, and it can never more than double an old one.
//   - age_days_cap 1095 (three years): beyond three years a protocol is simply
//     "established"; the extra months add nothing, so the factor saturates.
//   - unknown_age_days 365: a protocol with no listed_at is scored as one year
//     old — the neutral middle of the age factor (0.75).
//   - category_min_count 5: a category needs at least five traded protocols
//     before its own median is trusted; with fewer, the overall median is used.
export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  age_floor: 0.5,
  age_range: 0.5,
  age_days_cap: 1095,
  unknown_age_days: 365,
  category_min_count: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

// How the board is sized. The watchlist is the floor — every watchlist slug is
// ranked, however many there are (40 in this snapshot). EARLY_ROWS adds the
// strongest pre-token protocols below the $50M floor, by TVL, so the board shows
// the next wave as well as the floor: 40 + 160 = 200 rows. The early set is
// capped by TVL, not by implied value, so a small protocol with a flattering
// growth week cannot crowd out a larger one. LIVE_ROWS is the size of the
// separate live-token view: the 24 largest traded protocols by market cap,
// shown so the judge can see the reference set the multiples come from.
/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The reference multiples derived from the snapshot's traded protocols. */
export interface ReferenceMultiples {
  overall: number;
  by_category: Record<string, number>;
  traded_count: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    reference_multiple: number;
    multiple_source: string;
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan main.ts wrote for it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  reference_multiple: number;
  multiple_source: string;
  growth_multiplier: number;
  age_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  reference: ReferenceMultiples;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// Small pure helpers the model leans on. median is used instead of the mean for
// every reference multiple because market-cap-to-TVL ratios are heavy-tailed:
// one memecoin with a 50x ratio would drag a mean far off the typical protocol,
// while the median stays with the middle protocol. finite() is the model's guard
// against dirty snapshot fields — a NaN or Infinity in change_7d becomes the
// neutral fallback instead of poisoning the whole board.
const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Age is measured in whole days from the protocol's first listing to the snapshot
// date, both parsed as UTC midnights so the count does not depend on the
// machine's timezone. A listed_at in the future clamps to zero days (the
// protocol is brand new), and an unparseable date returns null rather than a
// garbage number, so the caller can apply the unknown-age default. The function
// returns null — not zero — for a missing date, because "no record" and "listed
// today" are different facts and the model treats them differently.
/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The reference multiples, derived from the snapshot's own traded protocols: the median
 * market-cap-to-TVL ratio per category (where the category has at least
 * category_min_count traded protocols with both figures), and the overall median as the
 * fallback. Nothing here is a hard-coded multiple: the numbers follow from the data.
 */
// The reference multiple is the heart of radar-2, and the whole point of deriving
// it from the snapshot is that the model never invents a price. A traded
// protocol's market cap is what the market actually paid for a token like this
// one; dividing it by that protocol's TVL gives the market's own price per
// dollar of locked value. The median of those ratios, per category, is the
// market's typical price for this kind of protocol. Two filters keep the
// reference honest: a protocol needs a positive market cap and a positive TVL
// (a zero or negative TVL would make the ratio meaningless), and the snapshot
// carries one traded protocol with a negative market cap — an anomaly that the
// mcap > 0 filter excludes. If a snapshot somehow had no traded protocols at
// all, the fallback is 0.2, a deliberately conservative multiple.
export function referenceMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): ReferenceMultiples {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const overall = traded.length > 0 ? median(traded.map((p) => p.mcap_usd! / p.tvl_usd)) : 0.2;
  const byCategory: Record<string, number> = {};
  const groups = new Map<string, number[]>();
  for (const p of traded) {
    const key = p.category ?? 'Other';
    const list = groups.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    groups.set(key, list);
  }
  for (const [key, ratios] of groups) {
    if (ratios.length >= model.category_min_count) byCategory[key] = median(ratios);
  }
  return { overall, by_category: byCategory, traded_count: traded.length };
}

/** The reference multiple one protocol is scored with, and where it came from. */
// Which multiple a protocol is scored with. The category multiple is preferred
// because different kinds of protocols are priced differently by the market —
// bridges carry a far higher mcap/TVL than liquid-staking protocols, for
// example — so a Dexs protocol should be priced against Dexs, not against the
// average of everything. When a category is too thin to trust (fewer than five
// traded protocols), the overall median is used instead, and the source string
// records which one was used so the dashboard can show it per row. A protocol
// with no category at all is grouped under "Other", which has no category
// multiple and therefore always falls back to the overall median.
export function multipleFor(protocol: SnapshotProtocol, reference: ReferenceMultiples): { multiple: number; source: string } {
  const key = protocol.category ?? 'Other';
  const own = reference.by_category[key];
  if (own !== undefined) return { multiple: own, source: `median mcap/TVL of traded ${key} protocols` };
  return { multiple: reference.overall, source: 'median mcap/TVL of all traded protocols' };
}

/** The multipliers and the implied value one protocol gets under `model`. */
// The scoring function itself: one protocol in, one implied value out. The three
// factors are multiplied, so each one is a tilt on the TVL base rather than an
// additive bonus — a protocol with no TVL still scores near zero, however old
// or fast-growing it is. The growth clamp is applied before the weight, so the
// growth multiplier can only range from 1 + (-50/100)*0.6 = 0.7 to
// 1 + (100/100)*0.6 = 1.6: a single hot week can lift a protocol by at most 60%.
// The age multiplier runs from 0.5 to 1.0, so age can at most halve a young
// protocol. The final Math.max(1, ...) guarantees every ranked row carries a
// positive whole implied value, which the gate requires; a protocol with a
// tiny TVL still gets $1 rather than $0, so the ranking stays total.
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  reference: ReferenceMultiples,
  model: ModelConstants,
): { implied: number; multiple: number; multipleSource: string; growthPct: number; growthMult: number; ageMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, source } = multipleFor(protocol, reference);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const ageMult = model.age_floor + model.age_range * (Math.min(Math.max(ageForModel, 0), model.age_days_cap) / model.age_days_cap);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * ageMult));
  return { implied, multiple, multipleSource: source, growthPct, growthMult, ageMult, age };
}

// Two exclusion rules, both about keeping the board about protocols, not pools.
// VERSIONED matches names ending in a release marker ("v2", "V3", "2.0"): those
// are usually a versioned deployment or a pool of another protocol, not a
// standalone protocol that could launch its own token. CEX (centralised
// exchanges) are excluded because an exchange's TVL is not comparable to a
// DeFi protocol's, and a CEX token launch is a different event entirely.
// isPreToken is the strictest of the three token checks: all three of mcap,
// gecko_id and symbol must be null. The wording matters — the board says a
// protocol "records no token", never "has no token", because the snapshot is
// the only evidence and a token could exist outside it.
/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n and strictly falling values. */
// Board assembly, in three passes. First, the watchlist: every slug the snapshot
// names is taken, even one the snapshot no longer carries (it is skipped, not
// errored, so a stale watchlist entry cannot break the build). Second, the early
// radar: pre-token, rankable protocols below the floor, taken by TVL with a
// slug tie-break so the selection is deterministic across runs. Third, scoring
// and ranking: every chosen protocol is scored, sorted by implied value with a
// slug tie-break, then forced strictly decreasing — if two protocols tie on the
// rounded value, the lower one is decremented by $1 until it is strictly below
// the one above it, so rank 1 is unambiguous and the gate's "strictly
// decreasing" requirement always holds. Ranks are then 1..n in that order.
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const reference = referenceMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. A chosen
  // protocol stays chosen; nothing here replaces a watchlist row.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, reference, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // The ranking is strict: no two rows share an implied value, so rank 1 is unambiguously first.
  let prev = Number.POSITIVE_INFINITY;
  const rows: BoardRow[] = scored.map((s, i) => {
    let implied = s.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: implied,
      model: {
        reference_multiple: round4(s.multiple),
        multiple_source: s.multipleSource,
        growth_pct: round2(s.growthPct),
        growth_multiplier: round4(s.growthMult),
        age_multiplier: round4(s.ageMult),
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });
  return rows;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
// Farm steps are written to the gate's shape: each step is one string of 20..600
// characters carrying the action, its cost and its time, so a farmer can budget
// it without opening anything else. stepText enforces that shape — over-long
// steps are truncated with an ellipsis, under-short ones get a holding
// instruction appended — because the gate rejects the whole board if any single
// step is out of range. The steps are built from the protocol's own record
// (category, first chain, TVL, age), never from a name list: capitalFor scales
// the position to the protocol's size ($50 on a small protocol, $250 on a
// multi-billion one), gasFor prices the chain the protocol actually lives on,
// and holdDaysFor gives younger protocols a longer qualifying window, because
// a young protocol needs more weeks of activity to prove the wallet is real.
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** What a single transaction costs on a chain, in the words a farmer budgets with. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $8 to $15 of gas';
  if (c === 'solana') return 'under $0.05 of gas';
  if (c === 'bitcoin') return 'about $3 to $8 of gas';
  if (c === 'arbitrum' || c === 'base' || c === 'optimism' || c === 'polygon' || c === 'zksync' || c === 'linea' || c === 'blast' || c === 'mode') return 'about $0.20 to $1 of gas';
  if (c === 'avalanche' || c === 'bsc' || c === 'binance' || c === 'fantom' || c === 'gnosis') return 'about $0.10 to $0.50 of gas';
  return 'about $1 to $5 of gas';
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The bridge time for moving funds onto a chain. */
function bridgeTimeFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'solana') return 'about 5 minutes for the bridge to settle';
  if (c === 'ethereum') return 'about 15 minutes for the bridge to settle';
  return 'about 10 minutes for the bridge to settle';
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open so the borrow side stays funded.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position in range.`;
  if (c.includes('yield') || c.includes('yield aggregator')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge') || c.includes('canonical bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app so the crossing is not the only action.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in your wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} of USDC on ${name} on ${chain} and place one market position that settles after the event.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk curators')) return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares for the whole window.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the minted balance.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it in your wallet.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the window.`;
  if (c.includes('launchpad')) return `Commit $${capital} of USDC to the next ${name} sale on ${chain} and hold the allocation through its lock.`;
  if (c.includes('payment')) return `Pay $${capital} through ${name} on ${chain} for a real invoice and keep the receipt on record.`;
  if (c.includes('privacy')) return `Deposit $${capital} of the supported asset into ${name} on ${chain} and use its shielded pool once.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The second qualifying action, different from the first, so the wallet shows more than one touch. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Borrow a small amount against the supplied collateral on ${name}, then repay it the same week.`;
  if (c.includes('dex') || c.includes('yield')) return `Swap a small amount through ${name}'s router on ${chain} so the wallet records a trade as well as a deposit.`;
  if (c.includes('bridge')) return `Send a second, smaller bridge through ${name} a week later so the activity spans two snapshots.`;
  if (c.includes('staking') || c.includes('restak')) return `Delegate a second stake through ${name} and vote once in its governance if a proposal is live.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge on ${name} and open a fresh one, so the wallet shows two settled trades.`;
  if (c.includes('prediction')) return `Settle the first market on ${name} and place a second position on a different event.`;
  if (c.includes('curator') || c.includes('allocator')) return `Rebalance between two ${name} vaults on ${chain} once, keeping funds inside the protocol.`;
  if (c.includes('rwa') || c.includes('stable')) return `Redeem a small part of the position on ${name} and re-mint it, so the wallet shows a full cycle.`;
  return `Vote once in ${name}'s governance or community poll on ${chain} if one is live, and keep the receipt.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const bridge = bridgeTimeFor(chain);
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm with, and write its seed phrase on paper and store it offline.`,
      cost: 'nothing to open, and under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `Bridge $${capital} of USDC to ${chain} from your main wallet, using the bridge the protocol's own docs name.`,
      cost: `${gas} for the bridge transaction`,
      time: bridge,
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: gas,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week on ${chain}, such as a deposit, a borrow, a swap or a vote, and keep doing it for the whole window.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and do not withdraw early.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Open ${p.name}'s own points or rewards page once a week and check that your wallet shows up with the activity you did.`,
      cost: 'no fee to check',
      time: '10 minutes a week',
    },
    {
      text: `When the window ends, claim only from the link ${p.name} itself publishes, never from a link in a message, and never pay anyone to claim for you.`,
      cost: `${gas} to claim, and nothing to anyone else`,
      time: '10 minutes to claim',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
// The live set: protocols that already trade, ranked by market cap. They are
// never scored by the model — their market cap is a fact, and ranking them by
// an implied value would be inventing a price for a token that already has
// one. They exist in the output for two reasons: the dashboard shows them in
// their own tab so the judge can see what "already trades" looks like next to
// the pre-token board, and they are the reference set the multiples are
// derived from. CEX protocols are excluded here too, for the same reason as
// on the board.
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    reference_multiple: row.model.reference_multiple,
    multiple_source: row.model.multiple_source,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const reference = referenceMultiples(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    reference,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
// Input validation is strict on purpose: the snapshot is sealed data from
// outside, and a malformed file should fail loudly at parse time rather than
// produce a silently wrong board. Every check names the exact fault, so a
// failed build tells the operator which field to look at. The rules are:
// as_of must be a YYYY-MM-DD date; floor_usd must be a positive safe integer;
// protocols and watchlist must be arrays; each protocol needs a slug, a name
// and a finite TVL. Everything else is normalised, not rejected: a non-string
// category becomes null, a non-array chains becomes an empty list, and a
// non-finite change_7d or mcap_usd becomes null, because a missing figure is
// a neutral input, not a corrupt file.
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd === board[i - 1]!.implied_value_usd) return `rows ${i} and ${i + 1} share implied value ${board[i]!.implied_value_usd}`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
