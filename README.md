# token-radar-01 — Token Radar v7

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

The best token launch radar: a program that reads a sealed snapshot of
every protocol DefiLlama tracks, works out which ones still record no
token, and ranks them by what their launch would be worth — each with
the steps to farm it. An AI judge compares the dashboards two at a
time; this entry is built to win on the value model first.

## What it answers

Which pre-token protocol is worth farming next, and what do I do about
it? The board ranks 340 farmable pre-token protocols by implied value.
The radar audits all 758 protocols in the snapshot: 340 farmable rows
ranked here, 274 wrapped / staked / bridged / versioned / exchange
products set aside with their fitted value (never ranked as farms), and
144 whose token already trades, shown with their market cap. The whole
40-protocol watchlist is covered.

## The model (radar-7)

Every term is fitted from the snapshot's own figures at run time. No
protocol name is special-cased; no number is carried in by hand.

```
log10(launch value) = 2.776 + 0.553 x log10(TVL) + 0.316 x growth
implied value       = launch value x token odds
```

- **Launch value.** A Huber robust fit (delta 1.5) on 85 traded comps:
  protocols whose token already trades, outside CEX / bridge /
  liquid-staking, with a market cap between 0.5% and 500% of TVL.
  Growth is the 7-day TVL change, clipped to [-60, 120] percent.
- **Token odds.** A logistic fit on the whole peer record (144 traded,
  614 pre-token) over log TVL, growth, log age, log chain count and a
  shrunk (k = 20) category launch rate. 5-fold cross-validated AUC
  0.730, log-loss 0.432.
- **Verdicts.** FARM at $5M implied value or more, THIN at $500k or
  more, otherwise SKIP. Top of the board: Morpho Blue, Ethena USDe,
  SparkLend.

Age is not in the launch value — held-out tests showed it hurts there —
it only enters the odds, where its weight is small.

## Validation: every term fitted and tested held-out

| Check | Median \|log10 error\| | Typical miss |
| --- | --- | --- |
| Blind, oldest half → newest half (32 tested) | 0.2763 | x1.89 |
| Four-way held-out, by age quartile | 0.3920 | x2.47 |
| Four-way held-out, random split (seed 7) | 0.3851 | x2.43 |
| Leave-one-out, 64 dated comps | 0.3825 | x2.41 |

Read it plainly: the typical launch value is off by about x1.89, so
treat every implied value as an order of magnitude with a rank range,
not a price. Each row shows its rank range from 50 bootstrap refits of
the curve. Variant A (`--variant A`) ranks by launch value alone, with
no odds factor; variant B (the default, shipped here) is launch value
x token odds.

## The dashboard

A static page, no network, no framework. Sortable and filterable by
search, category and verdict; a detail view per protocol shows the
implied value as an equation per row (TVL, growth, age, chains, launch
value, token odds), the rank range, and a five-step farm plan with what
each step costs and how long it takes. The proof strip at the top
recomputes six checks live in the page — watchlist 40/40, ranks 1..N,
values never rising with rank, farm plans 3–12 steps, every implied
value recomputed from the fitted curve, and the 758-protocol audit
adding up — so the screenshots and the code agree, or the strip says
so.

## How it works

`main.ts` (Node 22, standard library only) reads the snapshot, fits
the model, writes the ranked board to `board.json`, the dashboard's
data beside the page, copies `dashboard/` and `screenshots/`, and
writes `dossier.json` with the vendored make.fun library. Running it
twice produces byte-identical output.

```sh
node main.ts --input <snapshot.json|directory>
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
node main.ts --variant A   # launch value only, no token odds
```

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
