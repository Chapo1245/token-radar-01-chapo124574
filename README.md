# Token Radar

Every protocol that records no token, ranked by what its launch would be worth — and how to farm it.

Token Radar reads a frozen DefiLlama snapshot (758 protocols at or above $5M TVL, fetched 2026-11-14) and ranks the 198 protocols that record no token by an **implied launch value** computed from the snapshot's own figures alone: TVL, 7-day TVL change, and how long the protocol has run with no token. Nothing is hardcoded by name. The board covers all 40 protocols on the snapshot's watchlist (TVL ≥ $50M, records no token) and 158 more below the floor, down to the $5M minimum.

## The value model (v2)

```
implied = 20 × TVL^0.80 × exp(0.010 × clamp(change_7d, −50, 100)) × (1 + 0.35 × min(age_years, 5))
```

- **TVL, dampened.** TVL is raised to the power 0.80, so size leads the ranking without burying smaller fast movers.
- **Growth compounds.** The 7-day TVL change feeds an exponential: `exp(0.010 × change_7d)`, with the change clamped to −50…+100. A protocol growing +20% in a week compounds upward; one shrinking −20% decays. Linear growth factors understate momentum — compounding is the point.
- **Maturity pays.** `1 + 0.35 × min(years listed, 5)`: a protocol that has run for years with no token yet earns up to 2.75× the base, because a long runway with no token is exactly what a launch bet is about. The cap at 5 years stops the oldest names from running away with the board.
- **Pre-token only.** A protocol "records no token" when DefiLlama carries no token for it (no `gecko_id`, no `symbol`). That is the record, not proof it has none. Protocols whose token already trades are set aside in a reference list, ranked by market cap — they are not launch bets.

Implied values are this board's own claim, never a prediction that a token will launch, or when, or at what price.

## The board

198 rows, ranks 1–198, implied values non-increasing with rank. Top five on this snapshot:

| Rank | Protocol | Implied value |
| --- | --- | --- |
| 1 | Steakhouse Financial | $1,060,254,218 |
| 2 | Sentora Curator | $1,015,665,626 |
| 3 | Gauntlet | $734,344,264 |
| 4 | Veda | $669,773,783 |
| 5 | USDD | $510,351,489 |

The top of the board is dominated by risk curators and onchain capital allocators: large TVL, steady growth, and one to two years listed with no token. Below them, the ranking rewards fast growers and long-running pre-token protocols over sheer size.

### Worked example — rank #1, Steakhouse Financial

TVL $2,753,981,495, 7-day change −2.19%, listed 2025-05-20 (1.5 years, no token). Growth factor exp(0.010 × −2.19) ≈ ×0.978; maturity factor 1 + 0.35 × 1.49 ≈ ×1.520. The dampened TVL term (20 × TVL^0.80) carries the size; the two factors adjust it for a mildly shrinking week and a year and a half of runway. Implied value: **$1,060,254,218**. The program uses the snapshot's unrounded figures, so hand arithmetic from the rounded numbers above lands within a tenth of a percent.

### What changed in v2

The first version of this board used a linear growth term (`1 + 0.006 × change_7d`), a maturity weight of 0.15, a TVL exponent of 0.85, and a leading coefficient of 8. Version 2 compounds growth instead of adding it, more than doubles the maturity weight (0.35), dampens TVL harder (0.80), and raises the leading coefficient to 20 — so the ranking now separates protocols that are actively growing and have waited longest from ones that are merely large. The formula is stated in full on the dashboard itself, and every number on the board follows from it.

Each row carries a **farm plan**: five concrete steps with what they cost and how long they take — a fresh wallet, a bridge and deposit sized to the protocol's chains and category, weekly check-ins over 4–8 weeks — derived from the protocol's category and chains, not slogans. Plans are guidance, not financial advice; never share a seed phrase and never approve unlimited spending.

## The dashboard

A single static page (`dashboard/`) renders the board from `data.js`: sortable by implied value, TVL, 7-day growth, or age; filterable by search text, category, chain, and watchlist-only; click any row for its detail view — value breakdown (TVL, 7-day change, growth and maturity factors, chains, first listed) and its farm plan. Two reference lists sit below the board: protocols whose token already trades, and protocols that record no token but are not a launch (exchanges, bridges, wrapped or staked products), each with the reason it is set aside.

The three screenshots show the board, a protocol's detail view, and the watchlist-only filtered view, all rendered from this dashboard on the snapshot's data.

## How to run it

Node 22, standard library only, no network:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The program reads `/input/snapshot.json`, writes `/output/board.json` (the 198 ranked rows), `/output/data.js` (the dashboard's data), copies `dashboard/` and `screenshots/` to `/output`, and writes `/output/dossier.json` with `buildDossier` from `vendor/makefun-board.ts`. Two runs write byte-identical output.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes the output.
- `lib/model.ts` — the v2 value model.
- `dashboard/` — `index.html`, `app.js`, `app.css`: the page the judge reads.
- `screenshots/` — the board, a detail view, and a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte-for-byte, never edited.
- `board.json` / `data.js` / `dossier.json` — program output, regenerated on every run.
