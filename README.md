[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar — which tokenless protocol is worth farming?

Built for the [make.fun bounty](https://make.fun/bounty/token-radar-01).

A radar over the 758 protocols in the snapshot: every one of them ranked by an
implied launch value that is **fitted from the 144 protocols that already trade** —
a launch value from a comps curve, times the fitted odds that a token ever
appears. Traded protocols are kept in their own section with their recorded
market cap; they are never mixed into the pre-token ranking.

## The model (all fitted at build time from the snapshot alone)

1. **Launch value.** OLS curve on cleaned traded comps (exchange, bridge and
   liquid-staking products dropped; wild mcap/TVL multiples outside 0.005–5.0
   dropped):
   `log10(mcap) = 2.402 + 0.595 × log10(TVL)`, so launch value ≈ 252 × TVL^0.595.
2. **Growth.** The curve's residuals are regressed on the clipped 7-day TVL
   change with a robust (Huber) slope, so a fast-growing protocol is worth more
   than its TVL alone says.
3. **Token odds.** A logistic regression on the peer record (144 traded = 1,
   614 pre-token = 0) over log TVL, 7-day change, log age, chain count and a
   shrunk category launch rate. 5-fold cross-validated AUC 0.613 — weak but
   real signal: it separates the categories that do launch tokens from the ones
   that almost never do.
4. **Implied value = launch value × odds.** That is the expected value of the
   launch, and it is what the board ranks by.

Age is deliberately **not** in the launch value: held-out tests show an age
factor fitted on old protocols does not survive to young ones, so it only
enters the odds, where its fitted weight is small. The dashboard says so, and
shows the validation numbers (walk-forward median |log error| 0.279, odds AUC
0.613) instead of hiding them.

## What you get

- **Pre-token board (340 farmable rows)** — ranked by implied value, with launch value,
  token odds, a FARM / THIN / SKIP verdict and a costed farm plan per protocol.
  Variant C adds a rank range from 50 bootstrap refits, so the top rows show
  how stable their rank is. The other 274 pre-token rows are flagged products
  of a traded token (an exchange, a bridge, a versioned market) and are listed
  in their own section — their fitted value is shown, but they are not ranked
  as farms, because the comps curve does not apply to exchange TVL.
- **Traded section (144 rows)** — recorded market cap, clearly separated, with
  a "what to do instead of farming" note.
- **Proof strip** — six checks the dashboard runs live on its own data
  (watchlist 40/40, ranks 1..614 with no gaps, implied value never rising down
  the board, 3–12 farm steps per row, row count = snapshot size, odds in
  (0, 1)).
- **Search, category and verdict filters, sorting, and a detail view** with the
  full breakdown and farm plan for any protocol.

## Run it

```sh
node main.ts            # reads /input/snapshot.json, writes /output/
node main.ts --variant A   # launch-value ranking, no odds column
node main.ts --variant B   # odds × value + proof strip
node main.ts --variant C   # B + bootstrap rank ranges + walk-forward table
```

Deterministic: the same input always produces byte-identical output (fixed
bootstrap seed, no clock, no network). The dashboard needs no server — open
`output/dashboard/index.html` after a run.

## Files

- `main.ts` — build entrypoint (Node 22+ stdlib only)
- `lib/model.ts` — the fitted model, board builder and farm plans
- `dashboard/` — the radar page (HTML + CSS + JS, no network)
- `screenshots/` — the three board views
- `vendor/makefun-board.ts` — the scorer's gate/dossier helper, copied
  byte-for-byte from the kit

Implied values are this radar's claim, fitted from the snapshot — not a promise
that a token launches, and not financial advice.

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
