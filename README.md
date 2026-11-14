# Token Radar — token-radar-01

A token-launch radar for the make.fun `token-radar-01` bounty. The program reads a
frozen DefiLlama snapshot (`/input/snapshot.json`), finds the protocols that record
no token and are not a wrapped, staked or bridged product of a token that already
trades, ranks them by an implied launch value, and writes a dashboard with a farm
plan for each one.

## The value model

`implied_value = 8 × TVL^0.85 × growth × maturity`

- **TVL^0.85** — size matters, but dampened: a protocol ten times larger is worth
  about seven times more, so smaller fast movers are not buried.
- **growth = 1 + 0.006 × change_7d** — the snapshot's own 7-day TVL change,
  clamped to −50%…+100%. Missing change counts as 0%.
- **maturity = 1 + 0.15 × min(age_years, 5)** — years since DefiLlama first listed
  the protocol (1 year assumed when unlisted). A protocol that has run for years
  with no token has had longer to build the user base a launch would price.

The model reads only the snapshot's own figures — TVL, 7-day change, listing date —
never a list of names. Three variants were compared (linear TVL, dampened TVL,
growth-tilted); the dampened one won because it keeps the board's value spread
readable (276× top-to-bottom instead of 660×+) while letting growth move ranks.

Eligibility reuses the watchlist's own rule from the snapshot's field guide:
records no token, not a bridge / liquid-staking / restaking / CEX product, name not
versioned and carrying no whole word "wrapped", "staked" or "staking", and not
starting with an exchange name. That rule keeps exchanges and wrapped products
(Bybit, WBTC, Binance staked ETH — the largest no-token TVL in the file) off a
board about launches. The 40 watchlist protocols are all eligible; the board ranks
all 198 eligible protocols, 158 of them below the $50M watchlist floor.

## What the program writes

- `board.json` — 198 rows, ranks 1..198, implied values non-increasing.
- `data.js` — the board plus reference lists (already-launched protocols by market
  cap, and no-token protocols excluded from the launch board with their reason).
- `dashboard/` and `screenshots/` — copied through to `/output`.
- `dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only, no network. Running it twice writes byte-identical
output. The dashboard renders with no network: open `out/dashboard/index.html`.

## Language note

The snapshot is DefiLlama's record, not proof, so the board says a protocol
"records no token", never that it "has no token". Implied values are this entry's
own claim, never make.fun's, and never a prediction that a token will launch.
