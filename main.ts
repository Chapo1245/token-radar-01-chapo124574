// Token Radar v5 — entrypoint.
//
// Reads the sealed snapshot, prices every pre-token protocol with the
// comps-fitted model in lib/model.ts, and writes the ranked board, the
// dashboard's data, the dashboard and screenshots, and the dossier.
//
// Paths are resolved so the program runs the same way in the grader's
// sandbox as it does on a developer machine:
//   - input: --input, else $MAKEFUN_INPUT_DIR/snapshot.json, else
//     /input/snapshot.json (the sandbox's mount). Never a path under the
//     working directory: the repository is mounted read-only in the grader.
//   - output: $MAKEFUN_OUTPUT_DIR, else /output. Never a relative path:
//     a relative output would try to write into the read-only repository.
//   - dashboard/ and screenshots/ are read from this file's own directory
//     (import.meta.url), never from the working directory.
// The program takes no network, writes only under the output directory,
// uses no clock, no randomness and no locale-dependent formatting, so two
// runs write byte-identical output.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard } from "./lib/model.ts";
import type { PricedRow, Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOSSIER_TEXT_MAX_BYTES = 65536;

function fail(message: string): never {
  console.error(`token-radar: ${message}`);
  process.exit(1);
}

function inputPath(argv: string[]): string {
  const flag = argv.indexOf("--input");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  const fromEnv = process.env.MAKEFUN_INPUT_DIR;
  if (fromEnv) return join(fromEnv, "snapshot.json");
  return "/input/snapshot.json";
}

function outputPath(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
}

function readSnapshot(path: string): Snapshot {
  if (!existsSync(path)) {
    fail(
      `no snapshot at ${path} (pass --input, or set MAKEFUN_INPUT_DIR)`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Snapshot).protocols) ||
    !Array.isArray((parsed as Snapshot).watchlist)
  ) {
    fail(`snapshot at ${path} is not a token-radar snapshot`);
  }
  return parsed as Snapshot;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function main(): void {
  const snapshot = readSnapshot(inputPath(process.argv.slice(2)));
  const outDir = outputPath();
  mkdirSync(outDir, { recursive: true });

  const { rows, model } = buildBoard(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const covered = rows.filter((r) => r.watchlist).length;
  const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const row of rows) verdicts[row.verdict]++;

  const board = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model,
    rows_count: rows.length,
    watchlist_covered: `${covered}/${watchlist.size}`,
    verdicts,
    rows,
  };
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

  const dashboardData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model,
    rows_count: rows.length,
    watchlist_covered: `${covered}/${watchlist.size}`,
    verdicts,
    rows,
  };
  writeFileSync(
    join(outDir, "data.js"),
    `window.TOKEN_RADAR = ${JSON.stringify(dashboardData)};\n`,
  );

  copyTree(join(SCRIPT_DIR, "dashboard"), join(outDir, "dashboard"));
  copyTree(join(SCRIPT_DIR, "screenshots"), join(outDir, "screenshots"));

  const dossier = buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_MAX_BYTES });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const top = rows[0] as PricedRow | undefined;
  console.log(
    `token-radar v5: ${rows.length} rows, watchlist ${covered}/${watchlist.size}, ` +
      `verdicts FARM ${verdicts.FARM} / THIN ${verdicts.THIN} / SKIP ${verdicts.SKIP}, ` +
      `top ${top ? `${top.name} ${money(top.implied_value_usd)}` : "none"}`,
  );
}

function copyTree(from: string, to: string): void {
  if (!existsSync(from)) fail(`missing ${from} next to main.ts`);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
}

main();
