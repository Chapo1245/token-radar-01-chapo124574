// Token Radar — entrypoint (iteration v2).
//
// Reads the sealed snapshot, ranks the pre-token protocols by the v2 value
// model (see lib/model.ts), and writes everything the dashboard needs:
//
//   /output/board.json     the ranked board (rows, ranks, implied values, farm plans)
//   /output/data.js        window.TOKEN_RADAR: the board plus the reference lists
//   /output/dashboard/     a copy of this repo's dashboard/
//   /output/screenshots/   a copy of this repo's screenshots/
//   /output/dossier.json   buildDossier's dossier of dashboard/ + screenshots/
//
// Usage (from the repo root):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: fixed key order, a total sort (implied value,
// then slug), no clock, no randomness, no network. Two runs write the same
// bytes.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  BOARD_ROWS,
  MODEL_NOTE,
  MODEL_TEXT,
  buildBoard,
  buildLaunched,
  recordsNoToken,
  selectCandidates,
  type Snapshot,
} from './lib/model.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const DOSSIER_TEXT_MAX_BYTES = 65536;

function usageFail(message: string): never {
  throw new Error(`token-radar: ${message}\nusage: node main.ts --input <snapshot.json> (MAKEFUN_OUTPUT_DIR=<dir>)`);
}

function parseArgs(argv: string[]): { inputPath: string; outputDir: string } {
  let inputPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) inputPath = argv[++i] as string;
    else if (argv[i]?.startsWith('--input=')) inputPath = (argv[i] as string).slice('--input='.length);
  }
  if (!inputPath) usageFail('missing --input <snapshot.json>');
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
  return { inputPath, outputDir };
}

function loadSnapshot(path: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    usageFail(`cannot read snapshot at ${path}`);
  }
  const snap = parsed as Snapshot;
  if (!snap || typeof snap.as_of !== 'string' || !Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    usageFail(`snapshot at ${path} is not a token-radar snapshot`);
  }
  return snap;
}

function main(): void {
  const { inputPath, outputDir } = parseArgs(process.argv.slice(2));
  const snap = loadSnapshot(inputPath);

  const { candidates, setAside } = selectCandidates(snap);
  const { rows, watchlistCovered } = buildBoard(snap, candidates);
  if (rows.length !== BOARD_ROWS) {
    throw new Error(`token-radar: expected ${BOARD_ROWS} board rows, built ${rows.length}`);
  }
  if (watchlistCovered !== snap.watchlist.length) {
    throw new Error(`token-radar: watchlist covered ${watchlistCovered}/${snap.watchlist.length}`);
  }
  const launched = buildLaunched(snap);
  const tokenTrades = snap.protocols.filter((p) => !recordsNoToken(p)).length;

  // Gate guardrails, checked here so a bad row fails loudly instead of
  // shipping: implied values are positive whole dollars within the cap,
  // every row carries 3–12 farm steps of 20–600 characters each.
  for (const r of rows) {
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 100_000_000_000_000) {
      throw new Error(`token-radar: row ${r.slug} has an invalid implied value ${r.implied_value_usd}`);
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      throw new Error(`token-radar: row ${r.slug} has ${r.farm_steps.length} farm steps`);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) {
        throw new Error(`token-radar: row ${r.slug} has a farm step of ${t.length} characters`);
      }
    }
  }

  const board = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: MODEL_TEXT,
    rows_count: rows.length,
    watchlist_covered: watchlistCovered,
    rows,
  };
  const data = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: MODEL_TEXT,
    model_note: MODEL_NOTE,
    rows,
    launched,
    excluded_no_token: setAside,
    counts: {
      protocols: snap.protocols.length,
      candidates: rows.length,
      watchlist: snap.watchlist.length,
      token_trades: tokenTrades,
    },
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(join(outputDir, 'data.js'), 'window.TOKEN_RADAR = ' + JSON.stringify(data) + ';\n', 'utf8');

  // The dashboard and its screenshots are copied verbatim; the program never edits them.
  for (const dir of ['dashboard', 'screenshots']) {
    rmSync(join(outputDir, dir), { recursive: true, force: true });
    cpSync(join(REPO_ROOT, dir), join(outputDir, dir), { recursive: true });
  }

  const dossier = buildDossier(outputDir, { text_max_bytes: DOSSIER_TEXT_MAX_BYTES });
  writeFileSync(join(outputDir, 'dossier.json'), dossier);

  const top = rows[0] as (typeof rows)[number];
  console.log(
    `token-radar v2: ${rows.length} rows, watchlist ${watchlistCovered}/${snap.watchlist.length}, ` +
      `top ${top.name} $${top.implied_value_usd.toLocaleString('en-US')}`,
  );
}

main();
