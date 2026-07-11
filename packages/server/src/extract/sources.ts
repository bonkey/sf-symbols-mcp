import { existsSync } from "node:fs";
import { join } from "node:path";

export const SF_SYMBOLS_APP_ROOT = "/Applications/SF Symbols.app";
export const COREGLYPHS_ROOT =
  "/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources";

/** Resolved absolute paths of every metadata file we read. Optional = absent in degraded mode. */
export interface ExtractionSources {
  kind: "sf-symbols-app" | "coreglyphs-bundle";
  files: {
    nameAvailability: string;
    symbolCategories: string;
    categories: string;
    symbolSearch: string;
    nameAliases: string;
    layersetAvailability?: string | undefined;
    legacyAliases?: string | undefined;
    restrictions?: string | undefined;
    nofillToFill?: string | undefined;
    symbolOrder?: string | undefined;
    legacyFlippable?: string | undefined;
    semanticToDescriptive?: string | undefined;
    variantScriptsCsv?: string | undefined;
    versionPlist?: string | undefined;
  };
}

const optional = (path: string): string | undefined =>
  existsSync(path) ? path : undefined;

/**
 * Locate the SF Symbols metadata on this machine. Prefers the SF Symbols app
 * (which the user installed and licensed themselves); falls back to the
 * system CoreGlyphs bundle, which exists on every macOS but lacks
 * layerset availability and legacy aliases.
 *
 * Returns null when neither source exists (non-macOS or unusual setup).
 */
export function locateSources(
  opts: { appRoot?: string; coreGlyphsRoot?: string } = {},
): ExtractionSources | null {
  const appRoot = opts.appRoot ?? SF_SYMBOLS_APP_ROOT;
  const cgRoot = opts.coreGlyphsRoot ?? COREGLYPHS_ROOT;
  const appMetadata = join(appRoot, "Contents/Resources/Metadata");

  if (existsSync(join(appMetadata, "name_availability.plist"))) {
    return {
      kind: "sf-symbols-app",
      files: {
        nameAvailability: join(appMetadata, "name_availability.plist"),
        symbolCategories: join(appMetadata, "symbol_categories.plist"),
        categories: join(appMetadata, "categories.plist"),
        symbolSearch: join(appMetadata, "symbol_search.plist"),
        nameAliases: join(appMetadata, "name_aliases.strings"),
        layersetAvailability: optional(
          join(appMetadata, "layerset_availability.plist"),
        ),
        legacyAliases: optional(join(appMetadata, "legacy_aliases.strings")),
        restrictions: optional(join(cgRoot, "symbol_restrictions.strings")),
        nofillToFill: optional(join(cgRoot, "nofill_to_fill.strings")),
        symbolOrder: optional(join(cgRoot, "symbol_order.plist")),
        legacyFlippable: optional(join(cgRoot, "legacy_flippable.plist")),
        semanticToDescriptive: optional(
          join(cgRoot, "semantic_to_descriptive_name.strings"),
        ),
        variantScriptsCsv: optional(
          join(
            appRoot,
            "Contents/Frameworks/SFSymbolsShared.framework/Versions/A/Resources/SymbolVariantScripts.csv",
          ),
        ),
        versionPlist: optional(join(appRoot, "Contents/version.plist")),
      },
    };
  }

  if (existsSync(join(cgRoot, "name_availability.plist"))) {
    return {
      kind: "coreglyphs-bundle",
      files: {
        nameAvailability: join(cgRoot, "name_availability.plist"),
        symbolCategories: join(cgRoot, "symbol_categories.plist"),
        categories: join(cgRoot, "categories.plist"),
        symbolSearch: join(cgRoot, "symbol_search.plist"),
        nameAliases: join(cgRoot, "name_aliases.strings"),
        restrictions: optional(join(cgRoot, "symbol_restrictions.strings")),
        nofillToFill: optional(join(cgRoot, "nofill_to_fill.strings")),
        symbolOrder: optional(join(cgRoot, "symbol_order.plist")),
        legacyFlippable: optional(join(cgRoot, "legacy_flippable.plist")),
        semanticToDescriptive: optional(
          join(cgRoot, "semantic_to_descriptive_name.strings"),
        ),
        versionPlist: optional(join(cgRoot, "..", "Info.plist")),
      },
    };
  }

  return null;
}
