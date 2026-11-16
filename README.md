# token-radar-01-chapo124574

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: which pre-token protocol is worth farming next — priced off the
tokens that already trade, not off a list of names. It reads a sealed snapshot
of every protocol DefiLlama tracks, audits all 342 protocols that record no
token, ranks the 198 clean launches among them (the 40-protocol watchlist
plus 158 below-floor early finds) by implied launch value, and hands in a
dashboard with the board, a detail view for every protocol, a costed farm
plan ending in a FARM / THIN / SKIP verdict, and the full audit.

## How the board is priced

The model is fitted from the snapshot at run time; nothing about it is
hardcoded, and no protocol is named by hand.

- **Comparables:** the 85 protocols whose token already trades, cleaned of
  CEX, bridge and liquid-staking products (their tokens are not launches)
  and of multiples outside 0.005x–5.0x TVL.
- **Size curve, winsorized:** `log10(mcap) = 3.203 + 0.491 * log10(TVL)`
  (R² 0.272), least squares over the cleaned comparables after dropping the
  8 comparables whose residuals sit in the outer 5% on either side — so one
  outlier token cannot drag the whole board.
- **Blind test:** fitted on the 32 oldest comparables, tested on the 32
  newest the fit never saw — median error ×2.01; fitted the other way round,
  ×2.57. Geometric mean across the two splits ×2.27.
- **Category yardsticks:** each category's median market-cap / TVL (Dexs
  0.342x, Yield 0.256x, Lending 0.129x, RWA 0.275x, Basis Trading 0.482x;
  global median 0.223x). Thin rows (TVL under $20M) are also priced off
  their ten nearest comparables by size.
- **Shipped pricing:** the geometric mean of the size curve and the
  yardstick price, times a growth factor (7-day TVL change, weight 2.0,
  clamped −50%..+60%, floored at 0.10) and an age factor (0.60 per year with
  no token, capped at 5 years). Two other pricings were fitted and
  blind-tested on the same two splits and lost: the mild pricing (growth
  1.2, age 0.40, unwinsorized curve) at ×2.33 mean, and the sharp pricing
  (growth 3.0, age 1.20) at ×3.06 mean.
- **Farm verdicts:** FARM when implied value is at least $50M and 7-day TVL
  change is at least −10%; THIN at $10M / −30%; otherwise SKIP. Every plan
  is costed in dollars (gas + bridge + fees, from the protocol's own chain
  count) and netted against an illustrative farmer slice of 0.1% of implied
  value. Current board: 12 FARM, 99 THIN, 87 SKIP. Top pick: Steakhouse
  Financial, $216M implied.

## The audit — why 342, not 198

Every protocol that records no token is audited, including the 144 that are
not ranked as launches. A 342-row board would crown a CEX at $960M — 29 of
its top 40 would be wrapped, staked, bridged or exchange products — so the
board ranks only the 198 clean ones and the dashboard lists every excluded
protocol with its reason: 42 category CEX, 38 Liquid Staking, 28 Bridge,
15 Canonical Bridge, 11 name version markers, 5 wrapped / staked words,
3 Liquid Restaking, 2 Restaked BTC.

Implied value is this entry's own claim from the snapshot's figures. It never
predicts whether or when a token launches. A protocol is said to record no
token, never to have none.

Snapshot as of 2026-11-14: 758 protocols at or above $5M TVL, 40 on the
watchlist at a $50M floor, 85 cleaned comparables, 342 audited, 198 ranked.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads `/input/snapshot.json` (or
`$MAKEFUN_INPUT_DIR/snapshot.json`, or `--input`), writes the ranked board to
`/output/board.json`, the dashboard's data to `/output/data.js`, copies
`dashboard/` and `screenshots/` to `/output`, and writes `/output/dossier.json`
with `buildDossier` from `vendor/makefun-board.ts`. It takes no network,
writes only under the output directory, and uses no clock or randomness, so
two runs write byte-identical output. Output paths default to the absolute
`/input` and `/output` mounts, never to a path under the working directory:
the repository is mounted read-only when the entry is graded.

## Layout

- `main.ts` — entrypoint: paths, snapshot, outputs, dossier.
- `lib/model.ts` — the value model: comparables, winsorized size curve,
  yardsticks, pricing, verdicts, costed farm plans, audit.
- `vendor/makefun-board.ts` — the kit's dossier library, copied byte-for-byte.
- `dashboard/` — the static page: board, detail view, filters, method, audit.
- `screenshots/` — board, detail and filtered views of the dashboard.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
