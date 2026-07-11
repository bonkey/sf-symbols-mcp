import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCatalog } from "sf-symbols-mcp/extract";
import { GENERATED_DIR } from "./paths.js";

/** `pnpm extract` — extract the local catalog into generated-local/extracted/. */
export async function runExtract(): Promise<void> {
  const { catalog, manifest } = await extractCatalog();
  const dir = join(GENERATED_DIR, "extracted");
  await mkdir(dir, { recursive: true });

  const catalogPath = join(dir, `catalog-${catalog.sfSymbolsVersion}.json`);
  const manifestPath = join(dir, `manifest-${catalog.sfSymbolsVersion}.json`);
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `Extracted SF Symbols ${catalog.sfSymbolsVersion} (${manifest.source})\n` +
      `  raw symbols:        ${manifest.counts.rawSymbols}\n` +
      `  base symbols:       ${manifest.counts.baseSymbols}\n` +
      `  localized variants: ${manifest.counts.localizedVariants}\n` +
      `  aliases:            ${manifest.counts.aliases}\n` +
      `  restricted:         ${manifest.counts.restricted}\n` +
      `  → ${catalogPath}`,
  );
}
