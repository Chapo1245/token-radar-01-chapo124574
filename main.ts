// Token Radar — token-radar-01 entry.
//
// Reads /input/snapshot.json, ranks every launch candidate by its implied value,
// and writes board.json, data.js, the dashboard, the screenshots and dossier.json
// into the output directory. Node 22, standard library only, no network, fully
// deterministic: two runs write byte-identical output.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { exclusionReason, farmSteps, impliedValue, isLaunchCandidate } from './lib/model.ts';
import type { Protocol, Snapshot } from './lib/model.ts';

const repoRoot = dirname(fileURLToPath(import.meta.url));

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function readSnapshot(path: string): Snapshot {
  const raw = readFileSync(path, 'utf8');
  const snap = JSON.parse(raw) as Snapshot;
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error('snapshot.json is not the expected shape');
  }
  return snap;
}

function money(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + (n / 1e3).toFixed(0) + 'K';
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  tvl_usd: number;
  change_7d: number | null;
  category: string | null;
  chains: string[];
  listed_at: string | null;
  age_years: number;
  growth_factor: number;
  maturity_factor: number;
  watchlist: boolean;
  farm_steps: string[];
}

function buildBoard(snap: Snapshot): BoardRow[] {
  const watch = new Set(snap.watchlist);
  const ranked = snap.protocols
    .filter(isLaunchCandidate)
    .map((p) => ({ p, v: impliedValue(p, snap.as_of) }))
    .sort((a, b) => b.v.implied - a.v.implied || a.p.slug.localeCompare(b.p.slug));
  return ranked.map(({ p, v }, i) => ({
    slug: p.slug,
    name: p.name,
    rank: i + 1,
    implied_value_usd: v.implied,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    category: p.category,
    chains: p.chains,
    listed_at: p.listed_at,
    age_years: Math.round(v.age * 100) / 100,
    growth_factor: Math.round(v.growthFactor * 10000) / 10000,
    maturity_factor: Math.round(v.maturityFactor * 10000) / 10000,
    watchlist: watch.has(p.slug),
    farm_steps: farmSteps(p),
  }));
}

function launchedReference(snap: Snapshot): { name: string; symbol: string | null; mcap_usd: number; category: string | null }[] {
  return snap.protocols
    .filter((p: Protocol) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 12)
    .map((p) => ({ name: p.name, symbol: p.symbol, mcap_usd: p.mcap_usd ?? 0, category: p.category }));
}

function excludedReference(snap: Snapshot): { name: string; reason: string; tvl_usd: number }[] {
  return snap.protocols
    .filter((p: Protocol) => !isLaunchCandidate(p) && p.gecko_id === null && p.symbol === null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 12)
    .map((p) => ({ name: p.name, reason: exclusionReason(p) ?? '', tvl_usd: p.tvl_usd }));
}

function main(): void {
  const inputPath = argValue('--input') ?? '/input/snapshot.json';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const snap = readSnapshot(inputPath);
  const rows = buildBoard(snap);
  const missing = snap.watchlist.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length > 0) {
    throw new Error('board misses watchlist slugs: ' + missing.join(', '));
  }

  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });

  const board = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: 'implied = 8 * TVL^0.85 * (1 + 0.006 * clamp(change_7d, -50, 100)) * (1 + 0.15 * min(age_years, 5))',
    rows_count: rows.length,
    watchlist_covered: rows.filter((r) => r.watchlist).length,
    rows,
  };
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

  const data = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: board.model,
    model_note:
      'Implied value is this entry\'s own claim from the snapshot\'s figures: dampened TVL, 7-day growth and years listed with no token. It never predicts whether or when a token launches.',
    rows,
    launched: launchedReference(snap),
    excluded_no_token: excludedReference(snap),
    counts: {
      protocols: snap.protocols.length,
      candidates: rows.length,
      watchlist: snap.watchlist.length,
      token_trades: snap.protocols.filter((p: Protocol) => p.gecko_id !== null || p.symbol !== null).length,
    },
  };
  writeFileSync(join(outDir, 'data.js'), 'window.TOKEN_RADAR = ' + JSON.stringify(data) + ';\n', 'utf8');

  cpSync(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  const shotsDir = join(repoRoot, 'screenshots');
  if (existsSync(shotsDir)) {
    for (const f of readdirSync(shotsDir)) {
      if (f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg')) {
        cpSync(join(shotsDir, f), join(outDir, 'screenshots', f));
      }
    }
  }

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  console.log('token-radar: ' + rows.length + ' rows, watchlist ' + board.watchlist_covered + '/' + snap.watchlist.length + ', top ' + rows[0]!.name + ' ' + money(rows[0]!.implied_value_usd));
}

main();
