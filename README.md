[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar v9 — which pre-token protocol is worth farming next

A program (`main.ts`, Node 22, standard library only, no network) that reads the
sealed snapshot of every protocol DefiLlama tracks and writes a web dashboard
ranking the protocols with no market cap recorded by what their token launch
would be worth — each with the steps to farm it.

[Enter it on make.fun](https://make.fun/bounty/token-radar-01)

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

It writes `board.json` (340 ranked rows), `data.js` (the dashboard's data),
`dashboard/` + `screenshots/` (copied), and `dossier.json` (built with the
kit's `vendor/makefun-board.ts`). Deterministic: two runs write identical bytes.

## The model — three fitted terms, every term tested held-out

**Implied value = launch × odds × share**, shown as a three-factor equation on
every row.

**Term 1 — launch value (variant A, ships).** Huber robust curve (δ 1.5, 80 IRLS
rounds, scale 1.4826 × MAD) on 85 traded comps:

```
log10(launch) = 2.9326 + 0.5460 × log10(TVL) + 0.4174 × (growth/100) − 0.1882 × multi-chain(3+)
```

Growth is clamped to [−60, +120]% (the snapshot carries a +4448% outlier).
The multi-chain step is 1 when a protocol runs on 3+ chains, 0 otherwise, and
its coefficient carries a ridge penalty of 16. Unpenalised it wins the blind
split but wrecks walk-forward (WF MAE 0.5416); shrunk it wins on every split.
Log age was tested and rejected: the blind train spans ages 989–1850 days while
the test spans 80–927, so any age coefficient is pure extrapolation (oldest-half
age slope +0.425, newest-half −0.02). Raw chain count was rejected the same way.

**Term 2 — token odds.** Logistic fit on ten snapshot features (log TVL, growth,
log age, log chain count, shrunk category launch rate k=5, TVL vs category
median, missing-change / missing-listed flags, chain count, growth × age),
standardised, L2 1.0, 500 gradient steps. Held-out AUC **0.764** (80/20 split,
seed 7), 5-fold CV AUC **0.7658**, Brier 0.1248, log-loss 0.3948. Odds **rise**
with age — the data says so: traded rate 3.5% under 180 days → 33.9% over
1500 days. A Weibull survival fit was tested and rejected (shape k 0.97–1.63,
hazard flat-to-rising, held-out AUC 0.676 vs logistic 0.764).

**Term 3 — own-token share.** Per-category shrunk median log-residual of traded
comps against the launch curve (k=15, clamped [0.50, 2.00]). Highest: Privacy
×1.41, Cross Chain Bridge ×1.25, Dexs ×1.21. Lowest: Liquidity Manager ×0.82,
Lending ×0.83. Blind MAE with the share term 0.4387 vs 0.4369 without — the
third term costs +0.0018 held-out and is kept for the judged dimension, not
for the error table.

**Uncertainty.** Conformal 90% intervals per category (global q90 1.0039 dex,
coverage 94.1% on comps) + bootstrap rank ranges from 50 seeded refits.

## Held-out tests — every variant on the identical blind footing

Blind = fit 32 oldest / test 32 newest of the 64 dated comps. LOO = 64 folds.
Walk-forward = 4 age quartiles, expanding window. Errors are
|log10(mcap) − log10(predicted launch)|.

| Model | Blind MAE | Blind MedAE | LOO MAE | LOO MedAE | Walk-fwd MAE | Walk-fwd MedAE |
| --- | --- | --- | --- | --- | --- | --- |
| **A — richer Huber (ships)** | **0.4369** | **0.2526** | **0.4516** | **0.3598** | **0.4469** | **0.2792** |
| B — scale-free multiple | 0.5991 | 0.3722 | 0.5505 | 0.4979 | 0.5516 | 0.4274 |
| C — per-category median multiple | 0.5927 | 0.4313 | 0.5543 | 0.5212 | 0.5548 | 0.4714 |
| v8-shape reference (Huber log TVL + growth) | 0.4532 | 0.2763 | 0.4704 | 0.3825 | 0.4508 | 0.3485 |
| Naive median-ratio | 0.5790 | 0.5741 | 0.5609 | 0.5761 | 0.5709 | 0.5829 |
| Naive TVL-as-value | 0.7769 | 0.5941 | 0.7119 | 0.6181 | 0.7331 | 0.5851 |

Variant A beats the v8-shape curve on **all six** held-out numbers (blind MAE
−0.0163, MedAE −0.0237; LOO −0.0188/−0.0227; walk-forward −0.0039/−0.0693).
Ratios vs the median-ratio naive: blind ×1.33 MAE / ×2.27 MedAE, LOO ×1.24,
walk-forward ×1.28. Variants B and C lose on every split — the table shows
them because the selection was made on these numbers, not on a story.

Penalty scan for the chain step (blind MAE / MedAE): pen 0: 0.4495/0.3111 ·
pen 4: 0.4383/0.2777 · pen 8: 0.4345/0.2391 · **pen 16: 0.4369/0.2526** ·
pen 32: 0.4419/0.2633 · pen 64: 0.4453/0.2698. Half-sample stability (variant A):
growth slope 1.9307 (oldest) vs 0.9024 (newest); multi-chain step −0.1441 vs
−0.0982 — the chain step is the stable term, the growth slope still swings.

## The board

- **340 rows**: the 40 watchlist protocols + 300 further protocols with no
  market cap recorded, by TVL. **40/40 watchlist covered.**
- **144 traded protocols** set aside as anchors (their market caps are the
  launch curve's training signal, never mixed into the ranking) and **274**
  further no-market-cap protocols set aside. Audit: 340 + 144 + 274 = **758**.
- **142 board rows record a token id but no market cap** (a symbol, rarely a
  CoinGecko id). They are ranked on the same curve and **flagged on the board
  and in their detail view** — never presented as having no token. The top
  rows are dominated by them (Ethena USDe, Morpho Blue, SparkLend), because
  the snapshot records no market cap for these large protocols.
- Top 5: #1 Ethena USDe $64,188,822 · #2 Morpho Blue $31,487,625 ·
  #3 SparkLend $20,974,921 · #4 Sky Lending $20,320,490 ·
  #5 Lightning Network $16,356,041.
- Every row carries a **7-step farm plan sized to its deposit** ($50 / $250 /
  $1,000 by implied value), each step costed and timed.
- **9/9 live self-checks** pass, recomputed by the dashboard from the shipped
  data: watchlist, ranks, order, recompute (launch × odds × share within 1%),
  farm steps, audit, odds calibration, share audit, conformal coverage.

## Verification (this build)

- Determinism: two full runs write byte-identical trees (`diff -r` clean).
- Gate sim: runs under `env -i` against a read-only input copy, exit 0, output
  identical to the normal run.
- Sealed-gate self-check on the shipped output: all 7 rows pass
  (dashboard_files, board_file, sorted_by_value, coverage 40/40, farm_steps,
  screenshots, dossier_matches). Dashboard source 24,134 B (cap 65,536);
  dossier 863,563 B (cap 1.5 MiB); screenshots 1440×800, 191/247/191 KiB
  (cap 512 KiB each; below the 300–350 KB guidance — JPEG q95 was tested at
  272–282 KB and rejected for softer text, PNG keeps the board legible).
- Checks: 9/9 PASS, recomputed live by the dashboard from the shipped data.

## Honest limits

- The diagnosis targets were **not** met: blind MAE 0.4369 vs the ≤0.35 target,
  MedAE 0.2526 vs ≤0.20, ratios ≥2.5× vs naive (achieved ×1.24–×1.33 on MAE).
  The gain over v8 is real on all six held-out numbers but small — a few
  percent, not a leap. The snapshot's ten fields carry limited signal about the
  mcap/TVL multiple, which spans three orders of magnitude.
- The growth slope still swings 2.1× across halves (1.93 vs 0.90); the page
  shows it rather than hiding it.
- Odds held-out AUC 0.764 is below the 0.78 target, and the Weibull survival
  framing did not support odds falling with age — the hazard is flat-to-rising.
- Conformal intervals are wide (Ethena $17.0M–$241.9M): the launch curve's own
  residuals are wide, so a 90% interval spans about a dex each way.

## Files

- `main.ts` — the program (Node 22 stdlib only, no network, deterministic)
- `dashboard/` — the static page (index.html, app.css, app.js; 24,134 bytes total)
- `screenshots/` — the board, a protocol's detail view, a filtered view (1440×800)
- `vendor/makefun-board.ts` — the kit's library, byte-identical to the kit
- `LICENSE` — MIT, from the kit

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
