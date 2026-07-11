import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedCatalog } from "@sfsmcp/schema";
import { ExtractedCatalogSchema } from "@sfsmcp/schema";
import { GENERATED_DIR } from "./paths.js";

export {
  annotatableSymbols,
  deprecatedNames,
} from "sf-symbols-mcp/store/build-catalog";

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
