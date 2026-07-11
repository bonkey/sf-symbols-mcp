import type {
  Alias,
  Availability,
  ExtractedCatalog,
  ExtractedSymbol,
} from "@sfsmcp/schema";
import { ExtractedCatalogSchema } from "@sfsmcp/schema";
import type {
  RawLayersetAvailability,
  RawNameAvailability,
} from "./parse.js";

/** Everything the extractor read, in raw (already zod-validated) form. */
export interface RawMetadata {
  source: "sf-symbols-app" | "coreglyphs-bundle";
  version: { short: string; build?: string };
  nameAvailability: RawNameAvailability;
  layersetAvailability?: RawLayersetAvailability;
  categories: { key: string; label: string; icon?: string | undefined }[];
  symbolCategories: Record<string, string[]>;
  symbolSearch: Record<string, string[]>;
  nameAliases: Record<string, string>;
  legacyAliases?: Record<string, string>;
  restrictions?: Record<string, string>;
  nofillToFill?: Record<string, string>;
  symbolOrder?: string[];
  legacyFlippable?: string[];
  semanticToDescriptive?: Record<string, string>;
  /** script suffix -> script name, e.g. "ar" -> "Arabic" */
  scriptExtensions: Map<string, string>;
}

/**
 * Extract the referred-to product from an Apple restriction sentence.
 * "This symbol … may only be used to refer to Apple's AirTag." -> "AirTag".
 * The extracted phrase is a factual product reference; the full sentence
 * (Apple-authored text) is kept separately and never shipped.
 */
export function restrictionSubject(text: string): string | undefined {
  const match = text.match(/refer to (.+?)\.?$/);
  if (!match?.[1]) return undefined;
  return match[1].replace(/^Apple['’]s\s+/i, "").replace(/^the\s+/i, "");
}

/**
 * Fold localized script variants ("0.circle.ar") into their base symbol.
 * A name is a variant only when its final dot-token is a known script
 * extension AND the remaining stem exists as a symbol itself.
 */
export function splitScriptVariant(
  name: string,
  allNames: ReadonlySet<string>,
  scriptExtensions: ReadonlyMap<string, string>,
): { base: string; script: string } | null {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const suffix = name.slice(lastDot + 1);
  if (!scriptExtensions.has(suffix)) return null;
  const base = name.slice(0, lastDot);
  if (!allNames.has(base)) return null;
  return { base, script: suffix };
}

function resolveYearToken(
  token: string,
  yearToRelease: Record<string, Availability>,
  context: string,
  problems: string[],
): Availability {
  const availability = yearToRelease[token];
  if (!availability) {
    problems.push(`unknown year token "${token}" (${context})`);
    return {};
  }
  return availability;
}

/** Pure transformation from raw Apple metadata to the normalized catalog. */
export function normalizeCatalog(
  raw: RawMetadata,
  extractedAt: string,
): ExtractedCatalog {
  const problems: string[] = [];
  const { symbols: rawSymbols, year_to_release: yearToRelease } =
    raw.nameAvailability;
  const allNames = new Set(Object.keys(rawSymbols));

  // 1. Partition into base symbols and localized script variants.
  const variantsByBase = new Map<string, { name: string; script: string }[]>();
  const baseNames: string[] = [];
  for (const name of allNames) {
    const variant = splitScriptVariant(name, allNames, raw.scriptExtensions);
    if (variant) {
      const list = variantsByBase.get(variant.base) ?? [];
      list.push({ name, script: variant.script });
      variantsByBase.set(variant.base, list);
    } else {
      baseNames.push(name);
    }
  }
  baseNames.sort();

  // 2. Per-symbol layerset availability resolved through the layerset file's own year map.
  const layersetYearMap = raw.layersetAvailability?.year_to_release ?? {};
  const layersetSymbols = raw.layersetAvailability?.symbols ?? {};

  const sortIndex = new Map<string, number>(
    (raw.symbolOrder ?? []).map((name, i) => [name, i]),
  );
  const rtlFlippable = new Set(raw.legacyFlippable ?? []);
  const restrictions = raw.restrictions ?? {};

  const symbols: ExtractedSymbol[] = baseNames.map((name) => {
    const yearToken = rawSymbols[name] as string;
    const availability = resolveYearToken(
      yearToken,
      yearToRelease,
      `symbol ${name}`,
      problems,
    );

    const layersets: Record<string, Availability> = {};
    for (const [mode, token] of Object.entries(layersetSymbols[name] ?? {})) {
      layersets[mode] = resolveYearToken(
        token,
        layersetYearMap,
        `layerset ${mode} of ${name}`,
        problems,
      );
    }

    const restrictionText = restrictions[name];
    const variants = (variantsByBase.get(name) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return {
      name,
      yearToken,
      availability,
      categories: raw.symbolCategories[name] ?? [],
      appleSearchTerms: raw.symbolSearch[name] ?? [],
      layersets,
      restricted: restrictionText !== undefined,
      ...(restrictionText !== undefined && { restrictionText }),
      ...(restrictionText !== undefined && {
        restrictionSubject: restrictionSubject(restrictionText),
      }),
      rtlFlippable: rtlFlippable.has(name),
      localizedVariants: variants,
      ...(sortIndex.has(name) && { sortOrder: sortIndex.get(name) }),
    };
  });

  // 3. Aliases from all three Apple sources. Alias sources that are themselves
  //    catalog symbols are old-but-still-valid names (deprecation is derived
  //    downstream from this list).
  const aliases: Alias[] = [
    ...Object.entries(raw.nameAliases).map(([alias, canonical]) => ({
      alias,
      canonical,
      kind: "rename" as const,
    })),
    ...Object.entries(raw.legacyAliases ?? {}).map(([alias, canonical]) => ({
      alias,
      canonical,
      kind: "legacy" as const,
    })),
    ...Object.entries(raw.semanticToDescriptive ?? {}).map(
      ([alias, canonical]) => ({
        alias,
        canonical,
        kind: "semantic" as const,
      }),
    ),
  ].sort((a, b) => a.alias.localeCompare(b.alias) || a.kind.localeCompare(b.kind));

  // Alias targets should exist; a broken target means Apple changed something.
  for (const { alias, canonical } of aliases) {
    if (!allNames.has(canonical)) {
      problems.push(`alias "${alias}" points to unknown symbol "${canonical}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Catalog normalization found ${problems.length} problem(s):\n` +
        problems.slice(0, 20).join("\n") +
        (problems.length > 20 ? `\n… and ${problems.length - 20} more` : ""),
    );
  }

  return ExtractedCatalogSchema.parse({
    sfSymbolsVersion: raw.version.short,
    ...(raw.version.build !== undefined && {
      sfSymbolsBuild: raw.version.build,
    }),
    extractedAt,
    source: raw.source,
    yearToRelease,
    categories: raw.categories,
    symbols,
    aliases,
    nofillToFill: raw.nofillToFill ?? {},
  } satisfies ExtractedCatalog);
}
