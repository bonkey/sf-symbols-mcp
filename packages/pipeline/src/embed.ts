import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  TransformersEmbedder,
  semanticDoc,
  visualDoc,
  l2Normalize,
} from "sf-symbols-mcp/embed";
import { annotatableSymbols, loadExtractedCatalog } from "./catalog.js";
import { assembleAnnotations } from "./assemble.js";
import { GENERATED_DIR } from "./paths.js";

export const VISUAL_MODEL_ID = "Xenova/clip-vit-base-patch32";
export const VISUAL_DIMS = 512;

export interface EmbeddingsManifest {
  names: string[];
  textModel: string;
  textDims: number;
  visualModel?: string;
  visualDims?: number;
  /** Names that have a visual-description vector (subset of names). */
  visualDescNames: string[];
  /** Names that have a CLIP image vector (subset of names). */
  visualNames: string[];
}

function writeMatrix(vectors: Float32Array[], dims: number): Buffer {
  const buffer = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((vector, row) => {
    for (let i = 0; i < dims; i++) {
      buffer.writeFloatLE(vector[i] as number, (row * dims + i) * 4);
    }
  });
  return buffer;
}

/**
 * `pnpm embed [--skip-visual]` — build the three embedding spaces:
 * semantic text (all symbols), visual-description text (annotated symbols),
 * CLIP image vectors (rendered symbols). Maintainer-side; models download to
 * the HF cache on first run.
 */
export async function runEmbed(): Promise<void> {
  const skipVisual = process.argv.includes("--skip-visual");
  const catalog = await loadExtractedCatalog();
  const version = catalog.sfSymbolsVersion;
  const names = annotatableSymbols(catalog);
  const symbolsByName = new Map(catalog.symbols.map((s) => [s.name, s]));
  const annotations = await assembleAnnotations(version, names);

  const outDir = join(GENERATED_DIR, "embeddings", version);
  await mkdir(outDir, { recursive: true });

  const embedder = new TransformersEmbedder();

  // 1. Semantic text vectors — every annotatable symbol.
  console.log(`Embedding ${names.length} semantic docs …`);
  const semanticVectors: Float32Array[] = [];
  let done = 0;
  for (const name of names) {
    const doc = semanticDoc(
      name,
      symbolsByName.get(name)?.categories ?? [],
      annotations.get(name),
    );
    semanticVectors.push(await embedder.embedDoc(doc));
    if (++done % 500 === 0) console.log(`  semantic ${done}/${names.length}`);
  }
  await writeFile(
    join(outDir, "semantic.f32"),
    writeMatrix(semanticVectors, embedder.dims),
  );

  // 2. Visual-description text vectors — only annotated symbols.
  const visualDescNames: string[] = [];
  const visualDescVectors: Float32Array[] = [];
  for (const name of names) {
    const doc = visualDoc(annotations.get(name));
    if (!doc) continue;
    visualDescNames.push(name);
    visualDescVectors.push(await embedder.embedDoc(doc));
    if (visualDescNames.length % 500 === 0) {
      console.log(`  visualdesc ${visualDescNames.length}`);
    }
  }
  console.log(`Embedded ${visualDescNames.length} visual-description docs`);
  await writeFile(
    join(outDir, "visualdesc.f32"),
    writeMatrix(visualDescVectors, embedder.dims),
  );

  // 3. CLIP image vectors — rendered symbols.
  const visualNames: string[] = [];
  const visualVectors: Float32Array[] = [];
  if (!skipVisual) {
    const rendersDir = join(GENERATED_DIR, "renders", version);
    const { pipeline } = await import("@huggingface/transformers");
    console.log(`Loading ${VISUAL_MODEL_ID} …`);
    const imageExtractor = await pipeline(
      "image-feature-extraction",
      VISUAL_MODEL_ID,
      { dtype: "q8" },
    );
    for (const name of names) {
      const png = join(rendersDir, `${name}.png`);
      if (!existsSync(png)) continue;
      const output = (await imageExtractor(png)) as { data: Float32Array | number[] };
      visualNames.push(name);
      visualVectors.push(l2Normalize(new Float32Array(output.data)));
      if (visualNames.length % 500 === 0) {
        console.log(`  visual ${visualNames.length}/${names.length}`);
      }
    }
    await writeFile(
      join(outDir, "visual.f32"),
      writeMatrix(visualVectors, VISUAL_DIMS),
    );
  }

  const manifest: EmbeddingsManifest = {
    names,
    textModel: embedder.id,
    textDims: embedder.dims,
    ...(visualNames.length > 0 && {
      visualModel: VISUAL_MODEL_ID,
      visualDims: VISUAL_DIMS,
    }),
    visualDescNames,
    visualNames,
  };
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    `Embeddings done: semantic ${semanticVectors.length}, visualdesc ${visualDescVectors.length}, visual ${visualVectors.length} → ${outDir}`,
  );
}
