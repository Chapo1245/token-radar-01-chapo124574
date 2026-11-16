# token-radar-01-chapo124574

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: which pre-token protocol is worth farming next — priced off the
tokens that already trade, not off a list of names. It reads a sealed snapshot
of every protocol DefiLlama tracks, ranks the 198 protocols that record no
token (the 40-protocol watchlist plus 158 below-floor early finds) by implied
launch value, and hands in a dashboard with the board, a detail view for every
protocol, and a costed farm plan ending in a FARM / THIN / SKIP verdict.

## How the board is priced

The model is fitted from the snapshot at run time; nothing about it is
hardcoded, and no protocol is named by hand.

- **Comparables:** the 85 protocols whose token already trades, cleaned of CEX,
  bridge and liquid-staking products (their tokens are not launches) and of
  multiples outside 0.005x–5.0x TVL.
- **Size curve:** `log10(mcap) = 2.402 + 0.595 * log10(TVL)` (R² 0.264),
  least squares over the cleaned comparables.
- **Blind test:** fitted on the 32 oldest comparables, tested on the 32 newest
  the fit never saw — median error ×2.09, median ratio 0.69
  (10th–90th percentile 0.09–1.70). The previous version's blind error was
  ×3.4.
- **Category yardsticks:** each category's median market-cap / TVL (Dexs 0.342x,
  Yield 0.256x, Lending 0.129x, RWA 0.275x, Basis Trading 0.482x; global
  median 0.223x). Thin rows (TVL under $20M) are also priced off their ten
  nearest comparables by size.
- **Shipped pricing:** the geometric mean of the size curve and the yardstick
  price, times a growth factor (7-day TVL change, weight 1.5, clamped
  −50%..+60%, floored at 0.10) and an age factor (0.60 per year with no token,
  capped at 5 years). Two other pricings were fitted and blind-tested and lost:
  the pure curve (best blind error, but it under-prices the largest launches
  against the comparables' own multiples) and the pure yardstick (worst blind
  error, and it over-prices the top to $1.1B).
- **Farm verdicts:** FARM when implied value is at least $50M and 7-day TVL
  change is at least −10%; THIN at $10M / −30%; otherwise SKIP. Every plan is
  costed in dollars (gas + bridge + fees) and netted against an illustrative
  farmer slice of 0.1% of implied value. Current board: 12 FARM, 91 THIN,
  95 SKIP. Top pick: Steakhouse Financial, $296,155,817.

Implied value is this entry's own claim from the snapshot's figures. It never
predicts whether or when a token launches. A protocol is said to record no
token, never to have none.

Snapshot as of 2026-11-14: 758 protocols at or above $5M TVL, 40 on the
watchlist at a $50M floor, 85 cleaned comparables, 198 ranked rows.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads `/input/snapshot.json` (or
`$MAKEFUN_INPUT_DIR/snapshot.json`, or `--input`), writes the ranked board to
`/output/board.json`, the dashboard's data to `/output/data.js`, copies
`dashboard/` and `screenshots/` to `/output`, and writes `/output/dossier.json`
with `buildDossier` from `vendor/makefun-board.ts`. It takes no network, writes
only under the output directory, and uses no clock or randomness, so two runs
write byte-identical output. Output paths default to the absolute `/input` and
`/output` mounts, never to a path under the working directory: the repository is
mounted read-only when the entry is graded.

## Layout

- `main.ts` — entrypoint: paths, snapshot, outputs, dossier.
- `lib/model.ts` — the value model: comparables, size curve, blind test,
  yardsticks, pricing, verdicts, farm plans.
- `vendor/makefun-board.ts` — the kit's dossier library, copied byte-for-byte.
- `dashboard/` — the static page: board, detail view, filters, method.
- `screenshots/` — board, detail and filtered views of the dashboard.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
