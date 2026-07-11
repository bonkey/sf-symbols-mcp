import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeterministicFeatures,
  ExtractedCatalog,
} from "@sfsmcp/schema";
import { CATALOG_DDL, SCHEMA_VERSION } from "@sfsmcp/schema";
import {
  buildFamilies,
  computeFamilyKey,
} from "sf-symbols-mcp/search/family";
import {
  annotatableSymbols,
  deprecatedNames,
  loadExtractedCatalog,
} from "./catalog.js";
import { GENERATED_DIR } from "./paths.js";

/**
 * Data profiles, per the licensing policy:
 * - local:   everything extracted, for use on this machine only (incl. Apple
 *            search keywords and restriction sentences).
 * - default: the published package — names, availability, categories, our own
 *            annotations; NO Apple-authored keyword lists or restriction
 *            sentences (users merge those locally via update_local_catalog).
 * - safe:    only independently authored data + bare names.
 */
export type DataProfile = "local" | "default" | "safe";

const DIRECTIONS = new Set([
  "up",
  "down",
  "left",
  "right",
  "forward",
  "backward",
  "clockwise",
  "counterclockwise",
]);

/** "tray.and.arrow.down" -> "tray arrow down arrow_down" */
export function nameTokens(name: string): string {
  const tokens = name.split(".").filter((t) => t !== "and");
  const bigrams: string[] = [];
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1] as string;
    const b = parts[i] as string;
    if (DIRECTIONS.has(b) && a !== "and") bigrams.push(`${a}_${b}`);
  }
  return [...tokens, ...bigrams].join(" ");
}

interface BuildInputs {
  catalog: ExtractedCatalog;
  features: Record<string, DeterministicFeatures>;
  profile: DataProfile;
}

export function buildDatabase(dbPath: string, inputs: BuildInputs): void {
  const { catalog, features, profile } = inputs;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = MEMORY;");
  db.exec(CATALOG_DDL);

  const deprecated = deprecatedNames(catalog);
  const annotatable = new Set(annotatableSymbols(catalog));
  const families = buildFamilies(annotatable);

  // Canonical rename target for deprecated symbols (prefer "rename" over "legacy").
  const renamedTo = new Map<string, string>();
  for (const alias of catalog.aliases) {
    if (alias.kind === "legacy" && renamedTo.has(alias.alias)) continue;
    if (alias.kind === "rename" || alias.kind === "legacy") {
      renamedTo.set(alias.alias, alias.canonical);
    }
  }

  // Keywords per symbol: alias names pointing at it (+ Apple search terms in local profile).
  const aliasKeywords = new Map<string, string[]>();
  for (const alias of catalog.aliases) {
    const list = aliasKeywords.get(alias.canonical) ?? [];
    list.push(alias.alias.replaceAll(".", " "));
    aliasKeywords.set(alias.canonical, list);
  }

  const insertSymbol = db.prepare(
    `INSERT INTO symbols (
      name, base_name, modifiers_json, categories_json, availability_json,
      layersets_json, deprecated, renamed_to, restricted, restriction_subject,
      restriction_text, rtl_flippable, localized_variants_json, sort_order,
      apple_keywords_json, annotations_json, unannotated, phash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO symbol_fts (name_tokens, keywords, objects, actions, description, contexts, symbol_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFamily = db.prepare(
    `INSERT INTO families (base_name, members_json, analysis_json) VALUES (?, ?, ?)`,
  );
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO aliases (alias, canonical, kind) VALUES (?, ?, ?)`,
  );

  const shipAppleText = profile === "local";
  const shipAppleFacts = profile !== "safe";

  db.exec("BEGIN");
  for (const symbol of catalog.symbols) {
    const isDeprecated = deprecated.has(symbol.name);
    const familyKey = computeFamilyKey(symbol.name);
    const appleKeywords = shipAppleText ? symbol.appleSearchTerms : null;

    insertSymbol.run(
      symbol.name,
      familyKey.baseName,
      JSON.stringify(familyKey.modifiers),
      JSON.stringify(shipAppleFacts ? symbol.categories : []),
      JSON.stringify(shipAppleFacts ? symbol.availability : {}),
      JSON.stringify(shipAppleFacts ? symbol.layersets : {}),
      isDeprecated ? 1 : 0,
      renamedTo.get(symbol.name) ?? null,
      symbol.restricted ? 1 : 0,
      symbol.restrictionSubject ?? null,
      shipAppleText ? (symbol.restrictionText ?? null) : null,
      symbol.rtlFlippable ? 1 : 0,
      JSON.stringify(symbol.localizedVariants),
      symbol.sortOrder ?? null,
      appleKeywords ? JSON.stringify(appleKeywords) : null,
      null,
      1,
      features[symbol.name]?.phash ?? null,
    );

    if (!isDeprecated) {
      const keywords = [
        ...(appleKeywords ?? []),
        ...(aliasKeywords.get(symbol.name) ?? []),
      ].join(" ");
      insertFts.run(
        nameTokens(symbol.name),
        keywords,
        "",
        "",
        "",
        (shipAppleFacts ? symbol.categories : []).join(" "),
        symbol.name,
      );
    }
  }

  for (const family of families.values()) {
    insertFamily.run(family.baseName, JSON.stringify(family.members), null);
  }
  for (const alias of catalog.aliases) {
    insertAlias.run(alias.alias, alias.canonical, alias.kind);
  }

  const setMeta = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?)",
  );
  setMeta.run("schemaVersion", String(SCHEMA_VERSION));
  setMeta.run("sfSymbolsVersion", catalog.sfSymbolsVersion);
  setMeta.run("profile", inputs.profile);
  setMeta.run("generatedAt", catalog.extractedAt);
  db.exec("COMMIT");
  db.exec("PRAGMA optimize;");
  db.close();
}

/** `pnpm build-data [--profile local|default|safe]` */
export async function runBuildDb(): Promise<void> {
  const profileArg = process.argv.find((a) => a.startsWith("--profile="));
  const profile = (profileArg?.split("=")[1] ?? "local") as DataProfile;

  const catalog = await loadExtractedCatalog();
  const featuresPath = join(
    GENERATED_DIR,
    "features",
    catalog.sfSymbolsVersion,
    "features.json",
  );
  const features = JSON.parse(await readFile(featuresPath, "utf8").catch(() => '{"features":{}}')) as {
    features: Record<string, DeterministicFeatures>;
  };

  const outDir = join(GENERATED_DIR, "db");
  await mkdir(outDir, { recursive: true });
  const dbPath = join(outDir, `catalog-${profile}.db`);
  await rm(dbPath, { force: true });

  buildDatabase(dbPath, { catalog, features: features.features, profile });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = db.prepare("SELECT count(*) AS n FROM symbols").get() as {
    n: number;
  };
  const ftsCount = db.prepare("SELECT count(*) AS n FROM symbol_fts").get() as {
    n: number;
  };
  db.close();
  console.log(
    `Built ${dbPath} (profile=${profile}): ${count.n} symbols, ${ftsCount.n} in FTS`,
  );
}
