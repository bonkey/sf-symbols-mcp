import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { annotatableSymbols, loadExtractedCatalog } from "./catalog.js";
import { GENERATED_DIR, REPO_ROOT } from "./paths.js";

const execFileAsync = promisify(execFile);

const RENDERER_DIR = join(REPO_ROOT, "renderer");
const RENDERER_BIN = join(RENDERER_DIR, ".build", "release", "sfsymbols-render");

/** `pnpm render` — render all annotatable symbols to generated-local/renders/<version>/. */
export async function runRender(): Promise<void> {
  const catalog = await loadExtractedCatalog();
  const names = annotatableSymbols(catalog);

  console.log(`Building renderer …`);
  await execFileAsync("swift", ["build", "-c", "release"], {
    cwd: RENDERER_DIR,
    maxBuffer: 16 * 1024 * 1024,
  });

  const outDir = join(GENERATED_DIR, "renders", catalog.sfSymbolsVersion);
  await mkdir(outDir, { recursive: true });
  const namesFile = join(outDir, "names.txt");
  await writeFile(namesFile, names.join("\n"));

  console.log(`Rendering ${names.length} symbols → ${outDir}`);
  await execFileAsync(
    RENDERER_BIN,
    ["--out", outDir, "--size", "256", "--padding", "24", "--names-file", namesFile],
    { maxBuffer: 16 * 1024 * 1024 },
  );

  const manifest = JSON.parse(
    await readFile(join(outDir, "render-manifest.json"), "utf8"),
  ) as { renderedCount: number; failed: string[] };
  console.log(
    `Rendered ${manifest.renderedCount}/${names.length}; failed: ${manifest.failed.length}`,
  );
  if (manifest.failed.length > 0) {
    console.log(
      `Failed (likely newer than this macOS): ${manifest.failed.slice(0, 10).join(", ")}` +
        (manifest.failed.length > 10 ? " …" : ""),
    );
  }
}
