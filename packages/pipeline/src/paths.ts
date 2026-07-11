import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Monorepo root (packages/pipeline/src -> repo root). */
export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** All Apple-derived local outputs live here; gitignored, never committed. */
export const GENERATED_DIR = join(REPO_ROOT, "generated-local");
