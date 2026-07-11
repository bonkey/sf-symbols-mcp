import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Alias, ExtractedCatalog } from "@sfsmcp/schema";
import { ExtractedCatalogSchema } from "@sfsmcp/schema";
import { GENERATED_DIR } from "./paths.js";

/** Load the most recently extracted catalog from generated-local/extracted/. */
export async function loadExtractedCatalog(): Promise<ExtractedCatalog> {
  const dir = join(GENERATED_DIR, "extracted");
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.startsWith("catalog-") && f.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(
      `No extracted catalog found in ${dir}. Run \`pnpm extract\` first.`,
    );
  }
  return ExtractedCatalogSchema.parse(
    JSON.parse(await readFile(join(dir, latest), "utf8")),
  );
}

/**
 * Old-but-still-valid names: alias sources (rename/legacy) that are catalog
 * symbols themselves. They resolve to a canonical symbol, so rendering and
 * annotating them would duplicate work.
 */
export function deprecatedNames(catalog: ExtractedCatalog): Set<string> {
  const symbolNames = new Set(catalog.symbols.map((s) => s.name));
  const isRenamed = (a: Alias) => a.kind === "rename" || a.kind === "legacy";
  return new Set(
    catalog.aliases
      .filter((a) => isRenamed(a) && symbolNames.has(a.alias))
      .map((a) => a.alias),
  );
}

/** Base symbols worth rendering/annotating: non-deprecated bases. */
export function annotatableSymbols(catalog: ExtractedCatalog): string[] {
  const deprecated = deprecatedNames(catalog);
  return catalog.symbols
    .map((s) => s.name)
    .filter((name) => !deprecated.has(name));
}
