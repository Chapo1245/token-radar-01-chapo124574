// main.ts — Launch Radar: build the ranked board and the dashboard data.
//
// Reads the sealed snapshot, fits the comparables curve, ranks every
// radar-eligible pre-token protocol by its implied launch value, writes
// board.json and the dashboard's data.js, copies dashboard/ and
// screenshots/ into the output, and writes dossier.json with the kit's
// buildDossier. Standard library only; no network; deterministic — two
// runs on the same input write byte-identical output.
//
// Run it as the rules say:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// The input defaults to $MAKEFUN_INPUT_DIR/snapshot.json when --input is
// not given, and the output directory to $MAKEFUN_OUTPUT_DIR or "out".

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  anchorConstant,
  farmCost,
  farmSteps,
  fitComps,
  formulaText,
  impliedValue,
  isRadarEligible,
  verdictFor,
  yearsListed,
  type Snapshot,
  type SnapshotProtocol,
} from './lib/model.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

/** Read a --flag value from the arguments, or null when it is absent. */
function flagValue(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? (args[at + 1] as string) : null;
}

/** One board row: the ranked protocol, its figures and its farm plan. */
interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  tvl_usd: number;
  change_7d: number | null;
  age_years: number;
  category: string | null;
  chains: string[];
  verdict: string;
  farm_cost_usd: number;
  farm_steps: string[];
}

/** The whole board, in rank order, with the model that built it. */
function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; model: Record<string, unknown> } {
  const fit = fitComps(snapshot.protocols);
  // The board is every radar-eligible protocol, plus every watchlist slug
  // even if the eligibility rule would leave it out: the gate requires
  // the whole watchlist, and the watchlist is the floor, never the ceiling.
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const boardSet = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (isRadarEligible(p)) boardSet.set(p.slug, p);
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) boardSet.set(slug, p);
  }
  const board = [...boardSet.values()];
  const anchorK = anchorConstant(board, fit);

  const scored = board.map((p) => {
    const value = impliedValue(p, snapshot.as_of, anchorK);
    const cost = farmCost(p);
    const verdict = verdictFor(value, p.change_7d);
    return { p, value, cost, verdict };
  });
  // Rank by implied value, highest first; the slug breaks ties so the
  // order is the same on every run.
  scored.sort((a, b) => (b.value - a.value) || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: Math.max(1, Math.round(s.value)),
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_years: Math.round(yearsListed(s.p, snapshot.as_of) * 100) / 100,
    category: s.p.category,
    chains: s.p.chains,
    verdict: s.verdict,
    farm_cost_usd: s.cost.gasUsd + s.cost.capitalUsd,
    farm_steps: farmSteps(s.p, Math.max(1, Math.round(s.value)), s.verdict, s.cost),
  }));

  const model = {
    formula: formulaText(anchorK),
    anchor_k: Math.round(anchorK * 100) / 100,
    comps: {
      log_mcap: `${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(3)} x log10(TVL)`,
      intercept: Math.round(fit.intercept * 1000) / 1000,
      slope: Math.round(fit.slope * 1000) / 1000,
      r2: Math.round(fit.r2 * 1000) / 1000,
      n: fit.n,
      holdout_n: fit.holdoutN,
      holdout_median_log_error: Math.round(fit.holdoutMedianLogErr * 1000) / 1000,
      holdout_factor: Math.round(fit.holdoutFactor * 100) / 100,
    },
    verdict_rule:
      'FARM when implied value is at least $50M and 7-day TVL change is at least -10%; THIN when implied value is at least $10M and change is at least -30%; otherwise SKIP.',
    note: 'Implied value is this entry\u2019s own claim from the snapshot\u2019s figures. It never predicts whether or when a token launches. A protocol is said to record no token, never to have none.',
  };
  return { rows, model };
}

/** Write the outputs for one run. Returns the summary line for the log. */
function run(inputPath: string, outputDir: string): string {
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const { rows, model } = buildBoard(snapshot);
  const watchlistCovered = snapshot.watchlist.filter((slug) => rows.some((r) => r.slug === slug)).length;
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict as 'FARM' | 'THIN' | 'SKIP']++;

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const board = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model,
    rows_count: rows.length,
    watchlist_covered: `${watchlistCovered}/${snapshot.watchlist.length}`,
    verdicts: verdictCounts,
    rows,
  };
  writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');

  const data = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: model.formula,
    model_note: model.note,
    comps: model.comps,
    verdict_rule: model.verdict_rule,
    verdicts: verdictCounts,
    rows,
  };
  writeFileSync(join(outputDir, 'data.js'), `window.TOKEN_RADAR = ${JSON.stringify(data)};\n`, 'utf8');

  // The dashboard and its screenshots are copied as they stand in the
  // repository; the dossier is built from the copies, so what the judge
  // reads is exactly what this run wrote.
  cpSync(join(REPO_ROOT, 'dashboard'), join(outputDir, 'dashboard'), { recursive: true });
  cpSync(join(REPO_ROOT, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
  const dossier = buildDossier(outputDir, { text_max_bytes: 65536 });
  writeFileSync(join(outputDir, 'dossier.json'), dossier);

  const top = rows[0] as BoardRow;
  return `token-radar v4: ${rows.length} rows, watchlist ${watchlistCovered}/${snapshot.watchlist.length}, ` +
    `verdicts FARM ${verdictCounts.FARM} / THIN ${verdictCounts.THIN} / SKIP ${verdictCounts.SKIP}, ` +
    `top ${top.name} $${top.implied_value_usd.toLocaleString('en-US')}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const inputPath =
    flagValue(args, '--input') ??
    (process.env.MAKEFUN_INPUT_DIR ? join(process.env.MAKEFUN_INPUT_DIR, 'snapshot.json') : 'input/snapshot.json');
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
  if (!existsSync(inputPath)) {
    console.error(`token-radar: no snapshot at ${inputPath} (pass --input, or set MAKEFUN_INPUT_DIR)`);
    process.exit(1);
  }
  console.log(run(inputPath, outputDir));
}

main();
