import { DatabaseSync } from "node:sqlite";
import type {
  DeterministicFeatures,
  ExtractedCatalog,
  SymbolAnnotations,
} from "@sfsmcp/schema";
import { CATALOG_DDL, SCHEMA_VERSION } from "@sfsmcp/schema";
import { buildFamilies, computeFamilyKey } from "../search/family.js";

/** Alias sources (rename/legacy) that are catalog symbols themselves — old-but-valid names. */
export function deprecatedNames(catalog: ExtractedCatalog): Set<string> {
  const symbolNames = new Set(catalog.symbols.map((s) => s.name));
  return new Set(
    catalog.aliases
      .filter(
        (a) =>
          (a.kind === "rename" || a.kind === "legacy") &&
          symbolNames.has(a.alias),
      )
      .map((a) => a.alias),
  );
}

/** Base symbols worth rendering/annotating: non-deprecated bases. */
export function annotatableSymbols(catalog: ExtractedCatalog): string[] {
  const deprecated = deprecatedNames(catalog);
  return catalog.symbols.map((s) => s.name).filter((n) => !deprecated.has(n));
}

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

export interface EmbeddingMatrix {
  rowFor: Map<string, number>;
  dims: number;
  data: Buffer;
}

function sliceRow(matrix: EmbeddingMatrix, name: string): Buffer | null {
  const row = matrix.rowFor.get(name);
  if (row === undefined) return null;
  return matrix.data.subarray(row * matrix.dims * 4, (row + 1) * matrix.dims * 4);
}

export interface BuildInputs {
  catalog: ExtractedCatalog;
  features: Record<string, DeterministicFeatures>;
  annotations: Map<string, SymbolAnnotations>;
  familyAnalyses: Map<string, unknown>;
  embeddings: {
    semantic: EmbeddingMatrix | null;
    visualdesc: EmbeddingMatrix | null;
    visual: EmbeddingMatrix | null;
  };
  profile: DataProfile;
}

export function buildDatabase(dbPath: string, inputs: BuildInputs): void {
  const { catalog, features, annotations, familyAnalyses, embeddings, profile } =
    inputs;
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
      apple_keywords_json, annotations_json, unannotated, phash,
      embedding_semantic, embedding_visualdesc, embedding_visual
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  let annotated = 0;
  db.exec("BEGIN");
  for (const symbol of catalog.symbols) {
    const isDeprecated = deprecated.has(symbol.name);
    const familyKey = computeFamilyKey(symbol.name);
    const appleKeywords = shipAppleText ? symbol.appleSearchTerms : null;
    const symbolAnnotations = annotations.get(symbol.name) ?? null;
    if (symbolAnnotations?.reconciled) annotated++;

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
      symbolAnnotations ? JSON.stringify(symbolAnnotations) : null,
      symbolAnnotations?.reconciled ? 0 : 1,
      features[symbol.name]?.phash ?? null,
      embeddings.semantic ? sliceRow(embeddings.semantic, symbol.name) : null,
      embeddings.visualdesc
        ? sliceRow(embeddings.visualdesc, symbol.name)
        : null,
      embeddings.visual ? sliceRow(embeddings.visual, symbol.name) : null,
    );

    if (!isDeprecated) {
      const literal = symbolAnnotations?.literal?.value;
      const semantic = symbolAnnotations?.semantic?.value;
      const reconciled = symbolAnnotations?.reconciled?.value;
      // Mined aliases from glyph-inconsistent reconciliations are unreliable
      // search text (the blind passes misread the glyph) — keep them out of FTS.
      const minedAliases =
        reconciled && reconciled.nameGlyphConsistent
          ? reconciled.minedAliases
          : [];
      const keywords = [
        ...(appleKeywords ?? []),
        ...(aliasKeywords.get(symbol.name) ?? []),
        ...minedAliases,
      ].join(" ");
      const objects = [
        ...(literal?.primaryObjects ?? []),
        ...(literal?.secondaryObjects ?? []),
        ...(semantic?.likelyObjects ?? []),
      ].join(" ");
      const actions = (semantic?.likelyActions ?? []).join(" ");
      const description =
        reconciled?.finalDescription ?? literal?.literalDescription ?? "";
      const contexts = [
        ...(semantic?.uiContexts ?? []),
        ...(shipAppleFacts ? symbol.categories : []),
      ].join(" ");
      insertFts.run(
        nameTokens(symbol.name),
        keywords,
        objects,
        actions,
        description,
        contexts,
        symbol.name,
      );
    }
  }

  for (const family of families.values()) {
    const analysis = familyAnalyses.get(family.baseName);
    insertFamily.run(
      family.baseName,
      JSON.stringify(family.members),
      analysis ? JSON.stringify(analysis) : null,
    );
  }
  for (const alias of catalog.aliases) {
    insertAlias.run(alias.alias, alias.canonical, alias.kind);
  }

  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  setMeta.run("schemaVersion", String(SCHEMA_VERSION));
  setMeta.run("sfSymbolsVersion", catalog.sfSymbolsVersion);
  setMeta.run("profile", profile);
  setMeta.run("generatedAt", catalog.extractedAt);
  setMeta.run("annotatedCount", String(annotated));
  db.exec("COMMIT");
  db.exec("PRAGMA optimize;");
  db.close();
}

