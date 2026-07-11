import { existsSync, mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SymbolAnnotations, DeterministicFeatures } from "@sfsmcp/schema";
import { extractCatalog } from "../extract/index.js";
import {
  buildDatabase,
  type EmbeddingMatrix,
} from "../store/build-catalog.js";
import { compareOsVersions } from "../search/availability.js";

/** Per-user data directory for the locally refreshed catalog. */
export function userDataDir(): string {
  const dir =
    platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "sf-symbols-mcp")
      : join(
          process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
          "sf-symbols-mcp",
        );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function localCatalogPath(): string {
  return join(userDataDir(), "catalog-local.db");
}

export interface UpdateReport {
  status: "updated" | "up-to-date" | "unsupported-platform" | "source-not-found" | "dry-run";
  shippedVersion: string;
  localVersion?: string;
  added: string[];
  removed: string[];
  changed: number;
  unannotatedCount: number;
  note?: string;
}

/** Rebuild an EmbeddingMatrix from one BLOB column of the shipped DB. */
function matrixFromDb(
  db: DatabaseSync,
  column: string,
): EmbeddingMatrix | null {
  const rows = db
    .prepare(
      `SELECT name, ${column} AS vec FROM symbols WHERE ${column} IS NOT NULL`,
    )
    .all() as { name: string; vec: Uint8Array }[];
  if (rows.length === 0) return null;
  const dims = (rows[0] as { vec: Uint8Array }).vec.byteLength / 4;
  const data = Buffer.concat(rows.map((r) => Buffer.from(r.vec)));
  return {
    rowFor: new Map(rows.map((r, i) => [r.name, i])),
    dims,
    data,
  };
}

/**
 * Refresh the catalog from the locally installed SF Symbols app: extract the
 * current Apple metadata, carry over annotations/embeddings/features from the
 * shipped DB by symbol name, and build a complete replacement DB in the user
 * data directory. The server prefers it over the shipped DB when newer.
 */
export async function performLocalUpdate(
  shippedDbPath: string,
  opts: { dryRun?: boolean } = {},
): Promise<UpdateReport> {
  const shipped = new DatabaseSync(shippedDbPath, { readOnly: true });
  const shippedVersion =
    (
      shipped
        .prepare("SELECT value FROM meta WHERE key = 'sfSymbolsVersion'")
        .get() as { value: string } | undefined
    )?.value ?? "unknown";

  const fail = (
    status: UpdateReport["status"],
    note: string,
  ): UpdateReport => {
    shipped.close();
    return {
      status,
      shippedVersion,
      added: [],
      removed: [],
      changed: 0,
      unannotatedCount: 0,
      note,
    };
  };

  if (platform() !== "darwin") {
    return fail(
      "unsupported-platform",
      "Local extraction needs macOS (plutil + the SF Symbols app / CoreGlyphs bundle). Using shipped data.",
    );
  }

  let extraction;
  try {
    extraction = await extractCatalog();
  } catch (error) {
    return fail(
      "source-not-found",
      error instanceof Error ? error.message : "extraction failed",
    );
  }
  const { catalog } = extraction;
  const localVersion = catalog.sfSymbolsVersion;

  const shippedNames = new Set(
    (shipped.prepare("SELECT name FROM symbols").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const localNames = new Set(catalog.symbols.map((s) => s.name));
  const added = [...localNames].filter((n) => !shippedNames.has(n)).sort();
  const removed = [...shippedNames].filter((n) => !localNames.has(n)).sort();

  if (
    added.length === 0 &&
    removed.length === 0 &&
    compareOsVersions(localVersion, shippedVersion) <= 0
  ) {
    return {
      ...fail("up-to-date", "Shipped catalog already covers the local SF Symbols version."),
      localVersion,
    };
  }

  if (opts.dryRun) {
    const report: UpdateReport = {
      status: "dry-run",
      shippedVersion,
      localVersion,
      added,
      removed,
      changed: 0,
      unannotatedCount: added.length,
      note: `Would rebuild the local catalog at ${localCatalogPath()}.`,
    };
    shipped.close();
    return report;
  }

  // Carry independently-authored artifacts over from the shipped DB by name.
  const annotations = new Map<string, SymbolAnnotations>();
  const features: Record<string, DeterministicFeatures> = {};
  const carried = shipped
    .prepare(
      "SELECT name, annotations_json, phash FROM symbols WHERE annotations_json IS NOT NULL OR phash IS NOT NULL",
    )
    .all() as { name: string; annotations_json: string | null; phash: string | null }[];
  for (const row of carried) {
    if (!localNames.has(row.name)) continue;
    if (row.annotations_json) {
      annotations.set(row.name, JSON.parse(row.annotations_json) as SymbolAnnotations);
    }
    if (row.phash) {
      features[row.name] = { phash: row.phash } as DeterministicFeatures;
    }
  }
  const familyAnalyses = new Map<string, unknown>();
  const familyRows = shipped
    .prepare("SELECT base_name, analysis_json FROM families WHERE analysis_json IS NOT NULL")
    .all() as { base_name: string; analysis_json: string }[];
  for (const row of familyRows) {
    familyAnalyses.set(row.base_name, JSON.parse(row.analysis_json));
  }
  const embeddings = {
    semantic: matrixFromDb(shipped, "embedding_semantic"),
    visualdesc: matrixFromDb(shipped, "embedding_visualdesc"),
    visual: matrixFromDb(shipped, "embedding_visual"),
  };
  shipped.close();

  const target = localCatalogPath();
  const tmp = `${target}.tmp`;
  await rm(tmp, { force: true });
  buildDatabase(tmp, {
    catalog,
    features,
    annotations,
    familyAnalyses,
    embeddings,
    profile: "local",
  });
  await rm(target, { force: true });
  await rename(tmp, target);

  const rebuilt = new DatabaseSync(target, { readOnly: true });
  const unannotatedCount = (
    rebuilt
      .prepare("SELECT count(*) AS n FROM symbols WHERE unannotated = 1 AND deprecated = 0")
      .get() as { n: number }
  ).n;
  const changed = (
    rebuilt.prepare("SELECT count(*) AS n FROM symbols").get() as { n: number }
  ).n;
  rebuilt.close();

  return {
    status: "updated",
    shippedVersion,
    localVersion,
    added,
    removed,
    changed,
    unannotatedCount,
    note: `Local catalog rebuilt at ${target}; restart the server to pick it up if versions changed.`,
  };
}

/** Pick the freshest catalog DB: env override > newer local rebuild > shipped. */
export function preferredDbPath(shippedDbPath: string | null): string | null {
  const local = localCatalogPath();
  if (!existsSync(local)) return shippedDbPath;
  if (!shippedDbPath) return local;
  try {
    const localDb = new DatabaseSync(local, { readOnly: true });
    const localVersion = (
      localDb.prepare("SELECT value FROM meta WHERE key = 'sfSymbolsVersion'").get() as
        | { value: string }
        | undefined
    )?.value;
    localDb.close();
    const shippedDb = new DatabaseSync(shippedDbPath, { readOnly: true });
    const shippedVersion = (
      shippedDb.prepare("SELECT value FROM meta WHERE key = 'sfSymbolsVersion'").get() as
        | { value: string }
        | undefined
    )?.value;
    shippedDb.close();
    if (!localVersion) return shippedDbPath;
    if (!shippedVersion) return local;
    return compareOsVersions(localVersion, shippedVersion) > 0
      ? local
      : shippedDbPath;
  } catch {
    return shippedDbPath;
  }
}
