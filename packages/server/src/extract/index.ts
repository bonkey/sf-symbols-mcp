import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ExtractedCatalog, ExtractionManifest } from "@sfsmcp/schema";
import { ExtractionManifestSchema } from "@sfsmcp/schema";
import {
  FALLBACK_SCRIPT_EXTENSIONS,
  parseCategories,
  parseLayersetAvailability,
  parseNameAvailability,
  parseNameList,
  parseStringMap,
  parseSymbolCategories,
  parseSymbolSearch,
  parseVariantScriptsCsv,
} from "./parse.js";
import { plutilToJson } from "./plutil.js";
import { locateSources, type ExtractionSources } from "./sources.js";
import { normalizeCatalog, type RawMetadata } from "./normalize.js";

export * from "./sources.js";
export * from "./parse.js";
export * from "./normalize.js";
export { plutilToJson } from "./plutil.js";

export const EXTRACTOR_VERSION = "1";

const VersionPlistSchema = z
  .object({
    CFBundleShortVersionString: z.string().optional(),
    CFBundleVersion: z.string().optional(),
  })
  .loose();

async function readVersion(
  versionPlist: string | undefined,
): Promise<{ short: string; build?: string }> {
  if (!versionPlist) return { short: "unknown" };
  const parsed = VersionPlistSchema.parse(await plutilToJson(versionPlist));
  const short =
    parsed.CFBundleShortVersionString ?? parsed.CFBundleVersion ?? "unknown";
  return {
    short,
    ...(parsed.CFBundleVersion !== undefined && {
      build: parsed.CFBundleVersion,
    }),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export interface ExtractionResult {
  catalog: ExtractedCatalog;
  manifest: ExtractionManifest;
}

/**
 * Run a full extraction from the local SF Symbols installation.
 * macOS only (relies on plutil and Apple's local metadata files).
 */
export async function extractCatalog(
  opts: {
    appRoot?: string;
    coreGlyphsRoot?: string;
    now?: () => Date;
  } = {},
): Promise<ExtractionResult> {
  const sources = locateSources(opts);
  if (!sources) {
    throw new Error(
      "No SF Symbols metadata found. Install the SF Symbols app from " +
        "https://developer.apple.com/sf-symbols/ (or run on macOS, where the " +
        "system CoreGlyphs bundle provides a reduced catalog).",
    );
  }
  return extractFromSources(sources, opts.now ?? (() => new Date()));
}

export async function extractFromSources(
  sources: ExtractionSources,
  now: () => Date,
): Promise<ExtractionResult> {
  const { files } = sources;

  const [
    nameAvailability,
    symbolCategories,
    categories,
    symbolSearch,
    nameAliases,
    layersetAvailability,
    legacyAliases,
    restrictions,
    nofillToFill,
    symbolOrder,
    legacyFlippable,
    semanticToDescriptive,
    version,
  ] = await Promise.all([
    parseNameAvailability(files.nameAvailability),
    parseSymbolCategories(files.symbolCategories),
    parseCategories(files.categories),
    parseSymbolSearch(files.symbolSearch),
    parseStringMap(files.nameAliases, "name aliases"),
    files.layersetAvailability
      ? parseLayersetAvailability(files.layersetAvailability)
      : undefined,
    files.legacyAliases
      ? parseStringMap(files.legacyAliases, "legacy aliases")
      : undefined,
    files.restrictions
      ? parseStringMap(files.restrictions, "symbol restrictions")
      : undefined,
    files.nofillToFill
      ? parseStringMap(files.nofillToFill, "nofill to fill")
      : undefined,
    files.symbolOrder
      ? parseNameList(files.symbolOrder, "symbol order")
      : undefined,
    files.legacyFlippable
      ? parseNameList(files.legacyFlippable, "legacy flippable")
      : undefined,
    files.semanticToDescriptive
      ? parseStringMap(files.semanticToDescriptive, "semantic names")
      : undefined,
    readVersion(files.versionPlist),
  ]);

  const scriptExtensions = files.variantScriptsCsv
    ? parseVariantScriptsCsv(await readFile(files.variantScriptsCsv, "utf8"))
    : FALLBACK_SCRIPT_EXTENSIONS;

  const raw: RawMetadata = {
    source: sources.kind,
    version,
    nameAvailability,
    ...(layersetAvailability !== undefined && { layersetAvailability }),
    categories,
    symbolCategories,
    symbolSearch,
    nameAliases,
    ...(legacyAliases !== undefined && { legacyAliases }),
    ...(restrictions !== undefined && { restrictions }),
    ...(nofillToFill !== undefined && { nofillToFill }),
    ...(symbolOrder !== undefined && { symbolOrder }),
    ...(legacyFlippable !== undefined && { legacyFlippable }),
    ...(semanticToDescriptive !== undefined && { semanticToDescriptive }),
    scriptExtensions,
  };

  const extractedAt = now().toISOString();
  const catalog = normalizeCatalog(raw, extractedAt);

  const sourcePaths: Record<string, string> = {};
  const fileHashes: Record<string, string> = {};
  for (const [key, path] of Object.entries(files)) {
    if (!path) continue;
    sourcePaths[key] = path;
    fileHashes[key] = await sha256(path);
  }

  const localizedVariants = catalog.symbols.reduce(
    (sum, s) => sum + s.localizedVariants.length,
    0,
  );

  const manifest = ExtractionManifestSchema.parse({
    extractorVersion: EXTRACTOR_VERSION,
    sfSymbolsVersion: catalog.sfSymbolsVersion,
    ...(catalog.sfSymbolsBuild !== undefined && {
      sfSymbolsBuild: catalog.sfSymbolsBuild,
    }),
    source: sources.kind,
    sourcePaths,
    fileHashes,
    extractedAt,
    counts: {
      rawSymbols: Object.keys(nameAvailability.symbols).length,
      baseSymbols: catalog.symbols.length,
      localizedVariants,
      aliases: catalog.aliases.length,
      restricted: catalog.symbols.filter((s) => s.restricted).length,
    },
  } satisfies ExtractionManifest);

  return { catalog, manifest };
}
