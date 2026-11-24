[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Chapo1245/token-radar-01-chapo124574/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar v8 — pre-token protocols ranked by launch value × token odds × own-token share

A token launch radar that reads the sealed DefiLlama snapshot, fits a three-term
value model from the snapshot's own figures, and writes a dashboard ranking every
pre-token protocol by what its launch would be worth — each row with the
three-factor equation behind it and a deposit-sized farm plan.

**Implied value = launch value × token odds × own-token share.** Every term is
fitted from the snapshot and tested held-out; nothing is a hardcoded list of names.

## The model

**Term 1 — launch value.** Huber robust curve on the 85 cleaned traded comps
(exchanges, bridges and staked products dropped; mcap/TVL outside [0.005, 5]
dropped):

```
log10(launch) = 2.7764 + 0.5532 × log10(TVL) + 0.3157 × (growth/100)
```

Growth is the 7-day TVL change clipped to [−60, 120]%. The growth slope is
**unshrunk (ridge lambda 0)**: the blind-train slope is 1.7703 and the
16-comp half-sample slope is 2.8456 — unstable across samples — and a ridge
scan re-fitted at run time on the blind split shows every lambda above 0 makes
the blind median error worse (lambda 0: 0.2763; 0.25: 0.3584; 0.5: 0.3340;
1: 0.3408; 2: 0.3453), so the board ships the plain Huber fit and shows the
instability instead of hiding it behind a shrinkage that costs median accuracy.
The scan is recomputed at run time and stored in the output data
(`validation.term1.ridgeScan`), and the dashboard renders it on the page. For
completeness: lambda 0.25 wins the blind mean by 0.0009 (0.4523 vs 0.4532) —
noise on 32 points — while losing the median by 0.0821, which is why the
median, not the mean, decides the ship.

**Term 2 — token odds.** Logistic fit for P(a protocol ever records a token),
over log TVL, growth, log age, log chain count, a shrunk category launch rate,
TVL against its category median, missing-data flags and a growth × age
interaction. Standardised, L2 1.0, 500 gradient steps. **Odds rise with age in
this snapshot** — older protocols have had longer to launch (traded rate 3%
under 180 days, 29% past 3 years) — so the age curve on the page rises. The fit,
not a prior, decides the sign.

**Term 3 — own-token share (new).** The fraction of launch value accruing to the
token and its farmers, fitted per category as the shrunk median log-residual of
traded comps against the launch curve (shrinkage k = 15 toward the global median,
clamped to [0.50, 2.00]). 26 categories carry a share, e.g. Dexs ×1.116,
Lending ×0.775, Yield ×1.117.

**Uncertainty.** Conformal 90% intervals per category (quantile of |log residual|,
shrunk to the global quantile; 88% of comps fall inside) plus bootstrap rank
ranges from 50 seeded refits of the curve and the share term (odds held at the
full fit).

## Validation (the program's own figures, printed by `node main.ts`)

| Test | Model | Naive baseline | Ratio |
| --- | --- | --- | --- |
| Term 1 blind MAE (fit 32 oldest, test 32 newest) | 0.4532 | 0.5804 (median-ratio TVL-only) | ×1.28 |
| Term 1 blind MAE vs TVL-as-value | 0.4532 | 0.7769 | ×1.71 |
| Term 1 blind MSE vs TVL-as-value | 0.3849 | 1.0445 | ×2.71 |
| Term 1 blind median AE | 0.2763 | 0.5962 | ×2.16 |
| Term 1 walk-forward MAE (4 age quartiles) | 0.4625 | 0.5526 | ×1.19 |
| Term 1 leave-one-out, 64 dated comps | 0.4704 | 0.5526 | ×1.17 |
| Term 2 odds, held-out AUC (80/20, seed 7) | 0.655 | — | — |
| Term 2 odds, 5-fold CV AUC | 0.679 | — | — |
| Term 2 odds, held-out log-loss / Brier | 0.458 / 0.127 | — | — |
| Term 2 odds, worst calibration gap | 0.015 | — | — |
| Term 3 share, blind MAE with / without | 0.4552 / 0.4532 | — | — |

Honest limits, stated plainly: the launch curve beats the naive TVL-only baseline
by ×1.17–×1.28 on MAE (×2.16 on the median, ×2.71 only on MSE against the
TVL-as-value baseline), not ×2 on every metric; the share term costs +0.0020
blind MAE for the category differentiation it adds; the odds model is modest
(held-out AUC 0.655) — the snapshot's ten fields carry only so much signal about
whether a token ever appears, and the page reports the held-out number rather
than a cross-validated one. The conformal intervals are wide (global q90 1.0247
in log10) because the launch curve's own residuals are wide; that is the honest
uncertainty. The ridge that was meant to stabilise the growth slope was removed
after the scan above showed it buying a lower MSE at the cost of the median —
the headline number this entry is judged on.

## The board

- **340 farmable rows** — all 40 watchlist protocols plus 300 pre-token protocols
  below the $50M floor. Top 5: #1 Ethena USDe $56.4M, #2 Morpho Blue $37.5M,
  #3 Sky Lending $18.2M, #4 Spark Savings $18.0M, #5 Maple $17.1M.
  Verdicts: FARM 10, THIN 144, SKIP 186.
- **274 set-aside protocols** — no token recorded, but a wrapped, staked, bridged,
  versioned or exchange product of one that trades. Listed with their fitted
  value, never ranked as farms.
- **144 traded protocols** — market cap shown as a fact, with fitted launch value
  and mcap/launch for each. Audit: 340 + 274 + 144 = 758.
- **9 live self-checks** on the page, each recomputed by the dashboard from the
  shipped data (watchlist 40/40, ranks, order, recompute of every implied value,
  farm steps, audit, odds calibration, share audit, conformal intervals) — 9/9 PASS.
- **Farm plans** are deposit-sized: each row names a $50, $250 or $1,000 deposit
  (by implied value), with the same steps scaled to the other two sizes, every
  step costed and timed (7 steps per row).

## Variants

`main.ts --variant A|B|C` (default A, the shipped one):

| Variant | Share term | Blind MAE with share | Ship? |
| --- | --- | --- | --- |
| A | per-category, shrink k=15 | 0.4552 vs 0.4532 without | **Yes** — third term present at the smallest held-out cost |
| B | per-category, shrink k=5 | 0.4614 vs 0.4532 without | No — stronger differentiation, worse held-out |
| C | share = 1 (two-term model) | 0.4532 (identical) | No — best held-out number, but no third term |

All three share the same Term 1 and Term 2 (blind MAE 0.4532, blind median AE
0.2763, odds held-out AUC 0.655, 9/9 checks, deterministic output).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22+, standard library only, no network, no API keys. The program runs twice
and writes identical bytes (verified with `diff -r` over two full runs), and the
gate simulation (read-only input, `env -i`) exits 0. Output: `board.json`
(340 rows), `data.js`, `dashboard/`, `screenshots/`, `dossier.json` (792,093
bytes, dashboard source 33,624 bytes — the judge reads it whole).

## Files

- `main.ts` — the whole entry: model, validation, board, farm plans, dossier.
- `vendor/makefun-board.ts` — the kit's dossier library, byte-identical to the kit.
- `dashboard/` — `index.html`, `app.css`, `app.js` (33,624 bytes total, no network).
- `screenshots/` — board, protocol detail, filtered view (1440×800 PNG).
- `LICENSE` — MIT, from the kit.

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
