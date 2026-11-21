// Token Radar v6 — build entrypoint (written fresh, 21 Nov 2026).
//
// Reads /input/snapshot.json (or --input), writes /output/board.json,
// /output/data.js, /output/dossier.json and copies dashboard/ + screenshots/
// into /output. Runs twice with byte-identical results; no network, no clock
// (all figures come from the snapshot, the bootstrap uses a fixed seed).
//
// Usage: node main.ts [--input <path>] [--output <dir>] [--variant A|B|C]
// Defaults: input /input/snapshot.json (MAKEFUN_INPUT_DIR overrides the
// directory), output /output (MAKEFUN_OUTPUT_DIR overrides), variant C.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { parseSnapshot, buildBoard, dataScript, boardIssue } from './lib/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function fail(msg: string, code: number): never {
  console.error('token-radar: ' + msg);
  process.exit(code);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const inputPath = arg('--input') ?? join(inputDir, 'snapshot.json');
  const outputPath = arg('--output') ?? outputDir;
  const variantArg = (arg('--variant') ?? 'C').toUpperCase();
  if (variantArg !== 'A' && variantArg !== 'B' && variantArg !== 'C') {
    fail('--variant must be A, B or C', 2);
  }
  const variant = variantArg as 'A' | 'B' | 'C';

  if (!existsSync(inputPath)) fail('snapshot not found at ' + inputPath, 2);
  const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));

  const { rows, meta } = buildBoard(snapshot, { variant });
  const issue = boardIssue(rows, snapshot);
  if (issue) fail('board failed self-check: ' + issue, 1);

  mkdirSync(outputPath, { recursive: true });

  // board.json: the scored artifact. Rows sorted by rank (gate shape).
  const boardRows = [...rows].sort((a, b) => a.rank - b.rank);
  const board = {
    as_of: meta.asOf,
    generated_by: 'token-radar v6',
    variant: variant,
    count: boardRows.length,
    rows: boardRows.map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvlUsd,
      change_7d: r.change7d,
      age_days: r.ageDays,
      watchlist: r.watchlist,
      traded: r.traded,
      flag: r.flag,
      launch_value_usd: r.launchUsd,
      token_odds: r.odds,
      recorded_mcap_usd: r.recordedMcapUsd,
      implied_value_usd: r.impliedUsd,
      rank: r.rank,
      pre_token_rank: r.preRank,
      farmable_rank: r.farmRank,
      rank_lo: r.rankLo,
      rank_hi: r.rankHi,
      verdict: r.verdict,
      farm_cost_usd: r.farmCostUsd,
      farm_steps: r.farmSteps,
    })),
  };
  writeFileSync(join(outputPath, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

  // data.js: the dashboard's data (lives in /output, not in dashboard/,
  // so the dashboard source stays under the 64 KB cap).
  writeFileSync(join(outputPath, 'data.js'), dataScript(rows, meta), 'utf8');

  // dashboard/ + screenshots/ copied verbatim from this repo.
  cpSync(join(HERE, 'dashboard'), join(outputPath, 'dashboard'), { recursive: true });
  const shots = join(HERE, 'screenshots');
  if (existsSync(shots)) cpSync(shots, join(outputPath, 'screenshots'), { recursive: true });

  // dossier.json: the scorer's buildDossier, byte-for-byte, from the built
  // output tree (so dossier and output always agree).
  let dossierBytes: Uint8Array;
  try {
    dossierBytes = buildDossier(outputPath, {
      text_max_bytes: 65536,
      screenshots: { max: 4, max_bytes: 512 * 1024 },
      dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
    });
  } catch (e) {
    fail('dossier failed: ' + (e as Error).message, 1);
  }
  writeFileSync(join(outputPath, 'dossier.json'), Buffer.from(dossierBytes!), 'utf8');

  const top = boardRows.filter((r) => !r.traded).slice(0, 5);
  console.log(`token-radar v6 variant ${variant}: ${meta.nProtocols} protocols (${meta.nPreToken} pre-token, ${meta.nTraded} traded)`);
  console.log(`  comps ${meta.fit.nComps}; curve log10(mcap) = ${meta.fit.curveA.toFixed(3)} + ${meta.fit.curveB.toFixed(3)} log10(TVL)`);
  console.log(`  c7 Huber: intercept ${meta.fit.c7Intercept.toFixed(3)} slope ${meta.fit.c7Slope.toFixed(3)}`);
  console.log(`  odds 5-fold CV: AUC ${meta.fit.oddsAuc.toFixed(3)}, log-loss ${meta.fit.oddsLogloss.toFixed(3)}`);
  console.log(
    `  walk-forward (fit ${meta.fit.walkForward.nFit} oldest, test ${meta.fit.walkForward.nTest} newest): median |log error| ${meta.fit.walkForward.medianErr.toFixed(3)} (x${meta.fit.walkForward.factor.toFixed(2)})`,
  );
  console.log(`  verdicts: FARM ${meta.verdicts.farm}, THIN ${meta.verdicts.thin}, SKIP ${meta.verdicts.skip}, TRADED ${meta.verdicts.traded}`);
  console.log('  top pre-token: ' + top.map((r) => `#${r.preRank} ${r.name} $${r.impliedUsd.toLocaleString('en-US')}`).join(' | '));
  const files: string[] = [];
  walk(outputPath, files);
  console.log(`  wrote ${files.length} files to ${resolve(outputPath)}`);
}

main();
