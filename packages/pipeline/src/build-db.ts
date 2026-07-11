import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeterministicFeatures } from "@sfsmcp/schema";
import { DataManifestSchema, FamilyAnalysisSchema, SCHEMA_VERSION } from "@sfsmcp/schema";
import { buildFamilies } from "sf-symbols-mcp/search/family";
import { TEXT_DIMS } from "sf-symbols-mcp/embed";
import {
  buildDatabase,
  type DataProfile,
  type EmbeddingMatrix,
} from "sf-symbols-mcp/store/build-catalog";
import { listCheckpoints, readCheckpoint } from "./annotate/store.js";
import { assembleAnnotations } from "./assemble.js";
import { annotatableSymbols, loadExtractedCatalog } from "./catalog.js";
import type { EmbeddingsManifest } from "./embed.js";
import { GENERATED_DIR } from "./paths.js";

async function loadMatrix(
  dir: string,
  file: string,
  names: string[],
  dims: number,
): Promise<EmbeddingMatrix | null> {
  try {
    const data = await readFile(join(dir, file));
    if (data.length !== names.length * dims * 4) {
      throw new Error(
        `${file}: expected ${names.length * dims * 4} bytes, found ${data.length}`,
      );
    }
    return { rowFor: new Map(names.map((n, i) => [n, i])), dims, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `pnpm build-data [--profile=local|default|safe]` */
export async function runBuildDb(): Promise<void> {
  const profileArg = process.argv.find((a) => a.startsWith("--profile="));
  const profile = (profileArg?.split("=")[1] ?? "local") as DataProfile;

  const catalog = await loadExtractedCatalog();
  const version = catalog.sfSymbolsVersion;
  const names = annotatableSymbols(catalog);

  const featuresPath = join(GENERATED_DIR, "features", version, "features.json");
  const features = JSON.parse(
    await readFile(featuresPath, "utf8").catch(() => '{"features":{}}'),
  ) as { features: Record<string, DeterministicFeatures> };

  const annotations = await assembleAnnotations(version, names);

  const familyAnalyses = new Map<string, unknown>();
  for (const base of await listCheckpoints(version, "family")) {
    const checkpoint = await readCheckpoint(
      version,
      "family",
      base,
      FamilyAnalysisSchema,
    );
    if (checkpoint) familyAnalyses.set(base, checkpoint.value);
  }

  const embDir = join(GENERATED_DIR, "embeddings", version);
  let semantic: EmbeddingMatrix | null = null;
  let visualdesc: EmbeddingMatrix | null = null;
  let visual: EmbeddingMatrix | null = null;
  try {
    const manifest = JSON.parse(
      await readFile(join(embDir, "manifest.json"), "utf8"),
    ) as EmbeddingsManifest;
    semantic = await loadMatrix(embDir, "semantic.f32", manifest.names, manifest.textDims);
    visualdesc = await loadMatrix(
      embDir,
      "visualdesc.f32",
      manifest.visualDescNames,
      manifest.textDims,
    );
    if (manifest.visualDims) {
      visual = await loadMatrix(
        embDir,
        "visual.f32",
        manifest.visualNames,
        manifest.visualDims,
      );
    }
  } catch {
    console.log("No embeddings found — building DB without vectors.");
  }

  const outDir = join(GENERATED_DIR, "db");
  await mkdir(outDir, { recursive: true });
  const dbPath = join(outDir, `catalog-${profile}.db`);
  await rm(dbPath, { force: true });

  buildDatabase(dbPath, {
    catalog,
    features: features.features,
    annotations,
    familyAnalyses,
    embeddings: { semantic, visualdesc, visual },
    profile,
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (db.prepare("SELECT count(*) AS n FROM symbols").get() as { n: number }).n;
  const ftsCount = (db.prepare("SELECT count(*) AS n FROM symbol_fts").get() as { n: number }).n;
  const annotatedCount = (
    db.prepare("SELECT count(*) AS n FROM symbols WHERE unannotated = 0").get() as { n: number }
  ).n;
  const withVec = (
    db
      .prepare("SELECT count(*) AS n FROM symbols WHERE embedding_semantic IS NOT NULL")
      .get() as { n: number }
  ).n;
  db.close();

  const manifest = DataManifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    dataVersion: "0.1.0",
    profile: profile === "local" ? "full" : profile === "default" ? "full" : "safe",
    sfSymbolsVersion: version,
    generatedAt: catalog.extractedAt,
    embedding: { textModel: "Xenova/bge-small-en-v1.5", textDims: TEXT_DIMS },
    promptVersions: {},
    counts: {
      symbols: count,
      families: (() => {
        const familiesCount = buildFamilies(new Set(names)).size;
        return familiesCount;
      })(),
      annotated: annotatedCount,
    },
    hashes: {},
  });
  await writeFile(
    join(outDir, `manifest-${profile}.json`),
    JSON.stringify(manifest, null, 2),
  );

  console.log(
    `Built ${dbPath} (profile=${profile}): ${count} symbols, ${ftsCount} in FTS, ` +
      `${annotatedCount} annotated, ${withVec} with semantic vectors`,
  );
}
