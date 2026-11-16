# Launch Radar — Token Radar 01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Competition:** [make.fun/bounty/token-radar-01](https://make.fun/bounty/token-radar-01) — build the best token launch radar. Pot $1,325; deadline 14 Dec 2026.

**What this is:** a Node 22 program (`main.ts`, standard library only) that reads a sealed DefiLlama snapshot of 758 protocols and writes a web dashboard ranking the pre-token ones by what their launch would be worth — plus, for each one, a farm plan that says what it costs, how long it takes, and whether the farm is worth it at all.

## The board

- **198 protocols ranked**, every one of the snapshot's 40 watchlist protocols covered, plus 158 early finds below the $50M floor.
- **Top pick:** Steakhouse Financial — implied value $577.8M (TVL $2.75B, 7-day −2.2%, 1.5 years with no token recorded).
- **Verdicts:** 22 FARM, 92 THIN, 84 SKIP. A verdict is the net of a farm plan, not a slogan: each plan ends with its total gas, its working capital, its hours, and the reason for the call.
- The dashboard is sortable and filterable (search, category, verdict), has a detail view for every protocol, and renders with no network.

## The value model (v4)

The implied value follows from the snapshot's own figures only — TVL, seven-day growth, and how long the protocol has run with no token recorded. Nothing in the model names a protocol.

```
implied = 10.04 × TVL^0.80 × (1 + 1.5 × clamp(change_7d, −50, +60) / 100) × (1 + 0.45 × min(age_years, 5))
```

The constant **10.04 is anchored to the market, not picked by hand**. It comes from a comparables curve fitted on the trading protocols:

```
log10(mcap) = 3.908 + 0.405 × log10(TVL)   — 94 comparable trading protocols, R² 0.103
```

The constant is chosen so the model's median, at neutral growth and age, equals that curve's median prediction over the board. The curve was also **tested blind**: fitted on four fifths of the comparables and scored on the fifth (16 protocols), the median error was ×3.40 — wide, and stated as wide on the dashboard, which is why the curve anchors the scale while the power law carries the ranking.

Why this shape, and not the curve alone? The curve's slope (0.405) is so shallow that ranking on it alone barely separates a $5M protocol from a $2B one. TVL^0.80 keeps the ranking differentiated (top-to-100th ratio ≈ 50×) while the scale stays the market's. Growth is linear and clamped, so a single wild week — the snapshot holds a +4,448% seven-day spike — can add at most 90% and can never crown a protocol on its own. Age tops out at 3.25× for five years with no token recorded.

**Who is on the board.** Only genuine launch candidates: a protocol that records no token, and not a wrapped, staked or bridged product of a token that already trades, not an exchange, and not a versioned copy. That is the watchlist's own rule, applied without its $50M floor — which is how the board finds early protocols below the floor. Protocols whose token already trades are used only to fit the curve; they are not ranked. A protocol is always said to *record no token*, never to *have* none: its DefiLlama record may simply not carry one.

## Farm plans and verdicts

Each protocol gets five concrete steps, written from its own category, chains and numbers: set up a farming wallet and bridge in ($1–$5 bridge fee, 5–15 minutes), put capital to work in its core product, repeat weekly for 4–8 weeks, try a second feature in week two, then the net — total gas, working capital, hours, and the verdict:

- **FARM** — implied value at least $50M and 7-day TVL change at least −10%.
- **THIN** — implied value at least $10M and change at least −30%: farm small, only while the gas stays cheap.
- **SKIP** — anything else: the farm costs more in time than it is likely to return.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22.18 or later, nothing to install. The program reads the snapshot, writes `board.json` and `data.js`, copies `dashboard/` and `screenshots/` into the output, and writes `dossier.json` with the kit's `buildDossier`. Two runs on the same input write byte-identical output (verified with `diff -r`).

## Layout

```
main.ts                  entrypoint: read snapshot, rank, write outputs
lib/model.ts             the value model: comparables fit, implied value, verdicts, farm plans
vendor/makefun-board.ts  the kit's dossier library, copied byte-for-byte
dashboard/               index.html + app.css + app.js (static page, no network)
screenshots/             1-board.jpg · 2-detail.jpg · 3-filtered.jpg
```

## License

MIT — see [LICENSE](LICENSE). SPDX-License-Identifier: MIT.

---

Built for [make.fun](https://make.fun/bounty/token-radar-01). Referral: `wtacm6ft`.
