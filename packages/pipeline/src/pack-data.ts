import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEXT_MODEL_ID } from "sf-symbols-mcp/embed";
import { GENERATED_DIR, REPO_ROOT } from "./paths.js";

const DATA_PKG = join(REPO_ROOT, "packages", "data");

/** Locate the transformers.js model cache (inside the installed package). */
function findModelCache(): string | null {
  try {
    const transformersEntry = fileURLToPath(
      import.meta.resolve("@huggingface/transformers"),
    );
    // …/@huggingface/transformers/dist/… -> package root/.cache/<model id>
    let dir = dirname(transformersEntry);
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    const cache = join(dir, ".cache", TEXT_MODEL_ID);
    return existsSync(cache) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * `pnpm pack-data [--profile=default|safe]` — assemble the publishable
 * @sf-symbols-mcp/data package: profile-filtered catalog.db, manifest, and
 * the bundled text-embedding model (so users never download anything).
 */
export async function runPackData(): Promise<void> {
  const profileArg = process.argv.find((a) => a.startsWith("--profile="));
  const profile = profileArg?.split("=")[1] ?? "default";

  const dbSource = join(GENERATED_DIR, "db", `catalog-${profile}.db`);
  const manifestSource = join(GENERATED_DIR, "db", `manifest-${profile}.json`);
  if (!existsSync(dbSource)) {
    console.error(
      `Missing ${dbSource}. Run \`pnpm build-data --profile=${profile}\` first.`,
    );
    process.exit(2);
  }

  await cp(dbSource, join(DATA_PKG, "catalog.db"));
  await cp(manifestSource, join(DATA_PKG, "manifest.json"));

  const modelCache = findModelCache();
  if (!modelCache) {
    console.error(
      `Model cache for ${TEXT_MODEL_ID} not found. Run \`pnpm embed\` once (it downloads the model).`,
    );
    process.exit(2);
  }
  const modelTarget = join(DATA_PKG, "model", TEXT_MODEL_ID);
  await rm(join(DATA_PKG, "model"), { recursive: true, force: true });
  await mkdir(dirname(modelTarget), { recursive: true });
  await cp(modelCache, modelTarget, { recursive: true });

  // Keep only what the q8 runtime needs (drop other dtype variants).
  const onnxDir = join(modelTarget, "onnx");
  if (existsSync(onnxDir)) {
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(onnxDir)) {
      if (!file.includes("quantized") && !file.includes("q8")) {
        await rm(join(onnxDir, file), { force: true });
      }
    }
  }

  // Ship the NOTICE with the data package too.
  await cp(join(REPO_ROOT, "NOTICE"), join(DATA_PKG, "NOTICE"));

  const manifest = JSON.parse(await readFile(join(DATA_PKG, "manifest.json"), "utf8")) as {
    sfSymbolsVersion: string;
    counts: { symbols: number; annotated: number };
  };
  console.log(
    `Packed @sf-symbols-mcp/data (profile=${profile}): SF Symbols ${manifest.sfSymbolsVersion}, ` +
      `${manifest.counts.symbols} symbols, ${manifest.counts.annotated} annotated.`,
  );
}
