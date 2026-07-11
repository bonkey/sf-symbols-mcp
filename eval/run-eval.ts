/**
 * Golden-query ranking evaluation. Runs each query in two tracks:
 *   plain  — raw query string only (exercises the rule-based decomposer)
 *   decomp — with the pre-decomposed structured fields (isolates ranking)
 * Metrics: hit@1/3/5, MRR@10, nDCG@10 (best=3, acceptable=1, forbidden=-2),
 * scored at FAMILY granularity. Compares against eval/baseline.json when
 * present; `--update-baseline` rewrites it.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogStore } from "../packages/server/src/store/catalog-store.js";
import { TransformersEmbedder } from "../packages/server/src/embed/embedder.js";
import { SearchEngine } from "../packages/server/src/search/engine.js";
import { computeFamilyKey } from "../packages/server/src/search/family.js";
import type { SearchInput } from "../packages/server/src/search/schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = join(ROOT, "generated-local", "db", "catalog-local.db");
const GOLDEN_PATH = join(ROOT, "eval", "golden.json");
const BASELINE_PATH = join(ROOT, "eval", "baseline.json");

interface GoldenQuery {
  id: string;
  domain: string;
  query: string;
  decomposed: Partial<SearchInput>;
  best: string;
  acceptable: string[];
  forbidden: string[];
}

interface TrackMetrics {
  hit1: number;
  hit3: number;
  hit5: number;
  mrr10: number;
  ndcg10: number;
}

/** Resolve renamed symbols to their canonical name before computing the family key. */
let resolveAlias: (name: string) => string = (name) => name;
const familyOf = (name: string) => computeFamilyKey(resolveAlias(name)).baseName;

function gain(query: GoldenQuery, family: string): number {
  if (familyOf(query.best) === family) return 3;
  if (query.acceptable.some((a) => familyOf(a) === family)) return 1;
  if (query.forbidden.some((f) => familyOf(f) === family)) return -2;
  return 0;
}

function evaluateRanking(query: GoldenQuery, families: string[]): {
  hit1: boolean;
  hit3: boolean;
  hit5: boolean;
  rr: number;
  ndcg: number;
} {
  const relevant = (f: string) => gain(query, f) > 0;
  const rank = families.findIndex(relevant);
  const bestRank = families.findIndex((f) => familyOf(query.best) === f);

  let dcg = 0;
  families.slice(0, 10).forEach((family, i) => {
    dcg += gain(query, family) / Math.log2(i + 2);
  });
  // Ideal: best first, then acceptable.
  const idealGains = [3, ...query.acceptable.map(() => 1)].slice(0, 10);
  const idcg = idealGains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);

  return {
    hit1: bestRank === 0 || (rank === 0 && bestRank < 0),
    hit3: rank >= 0 && rank < 3,
    hit5: rank >= 0 && rank < 5,
    rr: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0,
    ndcg: idcg > 0 ? Math.max(0, dcg / idcg) : 0,
  };
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) {
    console.error(`No catalog DB at ${DB_PATH}. Run \`pnpm build-data\` first.`);
    process.exit(2);
  }
  const golden = JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as {
    queries: GoldenQuery[];
  };
  const store = new CatalogStore(DB_PATH);
  resolveAlias = (name) => store.resolveAlias(name) ?? name;
  const embedder = new TransformersEmbedder();
  const engine = new SearchEngine(store, embedder);
  await embedder.embedQuery("warmup");

  const tracks: Record<"plain" | "decomp", ReturnType<typeof evaluateRanking>[]> =
    { plain: [], decomp: [] };
  const failures: { id: string; track: string; top: string[] }[] = [];

  for (const query of golden.queries) {
    for (const track of ["plain", "decomp"] as const) {
      const input: SearchInput =
        track === "plain"
          ? { query: query.query, limit: 10 }
          : { query: query.query, limit: 10, ...query.decomposed };
      const response = await engine.search(input);
      const families = response.results.map((r) => r.family.baseName);
      const metrics = evaluateRanking(query, families);
      tracks[track].push(metrics);
      if (!metrics.hit5) {
        failures.push({ id: query.id, track, top: families.slice(0, 5) });
      }
    }
  }
  store.close();

  const summarize = (list: ReturnType<typeof evaluateRanking>[]): TrackMetrics => ({
    hit1: list.filter((m) => m.hit1).length / list.length,
    hit3: list.filter((m) => m.hit3).length / list.length,
    hit5: list.filter((m) => m.hit5).length / list.length,
    mrr10: list.reduce((s, m) => s + m.rr, 0) / list.length,
    ndcg10: list.reduce((s, m) => s + m.ndcg, 0) / list.length,
  });

  const results = {
    queries: golden.queries.length,
    plain: summarize(tracks.plain),
    decomp: summarize(tracks.decomp),
  };

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  for (const track of ["plain", "decomp"] as const) {
    const m = results[track];
    console.log(
      `${track.padEnd(6)} hit@1 ${pct(m.hit1)}  hit@3 ${pct(m.hit3)}  hit@5 ${pct(m.hit5)}  MRR@10 ${m.mrr10.toFixed(3)}  nDCG@10 ${m.ndcg10.toFixed(3)}`,
    );
  }
  if (failures.length > 0) {
    console.log(`\nmisses (not in top-5): ${failures.length}`);
    for (const failure of failures.slice(0, 15)) {
      console.log(`  [${failure.track}] ${failure.id}: ${failure.top.join(", ")}`);
    }
  }

  if (process.argv.includes("--update-baseline")) {
    await writeFile(BASELINE_PATH, JSON.stringify(results, null, 2));
    console.log(`\nBaseline updated → ${BASELINE_PATH}`);
    return;
  }

  if (existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as typeof results;
    const hit3Drop = baseline.decomp.hit3 - results.decomp.hit3;
    const ndcgDrop = baseline.decomp.ndcg10 - results.decomp.ndcg10;
    console.log(
      `\nvs baseline: hit@3 ${hit3Drop <= 0 ? "+" : "-"}${pct(Math.abs(hit3Drop))}, nDCG ${ndcgDrop <= 0 ? "+" : "-"}${Math.abs(ndcgDrop).toFixed(3)}`,
    );
    if (hit3Drop > 0.02 || ndcgDrop > 0.02) {
      console.error("REGRESSION: hit@3 or nDCG dropped beyond tolerance.");
      process.exit(1);
    }
  }
}

await main();
