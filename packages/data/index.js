import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the prebuilt catalog database. */
export const catalogDbPath = join(root, "catalog.db");
/** Absolute path to the data manifest. */
export const manifestPath = join(root, "manifest.json");
/** Absolute path to the bundled ONNX embedding model directory. */
export const modelDir = join(root, "model");
