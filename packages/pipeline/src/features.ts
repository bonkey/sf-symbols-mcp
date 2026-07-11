import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { DeterministicFeatures } from "@sfsmcp/schema";
import {
  buildFamilies,
  validateAgainstFillMap,
} from "sf-symbols-mcp/search/family";
import { annotatableSymbols, loadExtractedCatalog } from "./catalog.js";
import { GENERATED_DIR } from "./paths.js";

export const FEATURE_VERSION = "1";

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major grayscale bytes, 0 = black ink, 255 = white background. */
  data: Uint8Array;
}

export async function loadGray(path: string): Promise<GrayImage> {
  const { data, info } = await sharp(path)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

const INK_THRESHOLD = 128;

/** Binarized ink mask: true = glyph pixel. */
function inkMask(img: GrayImage): boolean[] {
  const mask = new Array<boolean>(img.width * img.height);
  for (let i = 0; i < img.data.length; i++) {
    mask[i] = (img.data[i] as number) < INK_THRESHOLD;
  }
  return mask;
}

function connectedComponents(
  mask: boolean[],
  width: number,
  height: number,
): number {
  const visited = new Uint8Array(mask.length);
  let components = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    components++;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (mask[nidx] && !visited[nidx]) {
            visited[nidx] = 1;
            stack.push(nidx);
          }
        }
      }
    }
  }
  return components;
}

/**
 * Pixels enclosed by ink ("holes"): non-ink pixels not reachable from the
 * image border through non-ink pixels. An outlined shape has a large hole,
 * a filled one has none — the basis of fillScore.
 */
function enclosedHoles(mask: boolean[], width: number, height: number): number {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (idx: number) => {
    if (!mask[idx] && !outside[idx]) {
      outside[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }
  let holes = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !outside[i]) holes++;
  }
  return holes;
}

/** Jaccard similarity of the ink set with its mirrored self. */
function mirrorSymmetry(
  mask: boolean[],
  width: number,
  height: number,
  axis: "horizontal" | "vertical",
): number {
  let intersection = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = mask[y * width + x] as boolean;
      const b =
        axis === "horizontal"
          ? (mask[y * width + (width - 1 - x)] as boolean)
          : (mask[(height - 1 - y) * width + x] as boolean);
      if (a && b) intersection++;
      if (a || b) union++;
    }
  }
  return union === 0 ? 1 : intersection / union;
}

/** Separable 2D DCT-II of a square image. */
export function dct2d(input: Float64Array, n: number): Float64Array {
  const cosTable = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      cosTable[k * n + i] = Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
    }
  }
  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        sum += (input[y * n + x] as number) * (cosTable[k * n + x] as number);
      }
      rows[y * n + k] = sum;
    }
  }
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let y = 0; y < n; y++) {
        sum += (rows[y * n + x] as number) * (cosTable[k * n + y] as number);
      }
      out[k * n + x] = sum;
    }
  }
  return out;
}

/** 64-bit perceptual hash: 32x32 DCT, top-left 8x8 minus DC, median threshold. */
export async function phashFromPng(path: string): Promise<string> {
  const { data } = await sharp(path)
    .greyscale()
    .resize(32, 32, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const input = new Float64Array(32 * 32);
  for (let i = 0; i < input.length; i++) input[i] = data[i] as number;
  const dct = dct2d(input, 32);

  const coeffs: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue;
      coeffs.push(dct[y * 32 + x] as number);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median =
    ((sorted[31] as number) + (sorted[32] as number)) / 2; // 63 coefficients

  let bits = 0n;
  // 63 coefficient bits + 1 padding zero bit -> 64-bit hash.
  for (const c of coeffs) {
    bits = (bits << 1n) | (c > median ? 1n : 0n);
  }
  bits <<= 1n;
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(hashA: string, hashB: string): number {
  let diff = BigInt(`0x${hashA}`) ^ BigInt(`0x${hashB}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

export async function computeFeatures(
  pngPath: string,
): Promise<DeterministicFeatures> {
  const img = await loadGray(pngPath);
  const { width, height } = img;
  const mask = inkMask(img);

  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    ink = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error(`empty glyph image: ${pngPath}`);

  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height
      ? (mask[y * width + x] as boolean)
      : false;

  let edge = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!at(x, y)) continue;
      const four = at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1);
      if (!four) edge++;
    }
  }
  const holes = enclosedHoles(mask, width, height);

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;

  return {
    inkDensity: ink / (width * height),
    bbox: { x: minX, y: minY, w: bboxW, h: bboxH },
    aspectRatio: bboxW / bboxH,
    connectedComponents: connectedComponents(mask, width, height),
    symmetryH: mirrorSymmetry(mask, width, height, "horizontal"),
    symmetryV: mirrorSymmetry(mask, width, height, "vertical"),
    complexity: edge / ink,
    fillScore: ink / (ink + holes),
    phash: await phashFromPng(pngPath),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

/** `pnpm features` — compute image features + family grouping for the rendered catalog. */
export async function runFeatures(): Promise<void> {
  const catalog = await loadExtractedCatalog();
  const rendersDir = join(GENERATED_DIR, "renders", catalog.sfSymbolsVersion);
  const outDir = join(GENERATED_DIR, "features", catalog.sfSymbolsVersion);
  await mkdir(outDir, { recursive: true });

  const rendered = (await readdir(rendersDir))
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.slice(0, -4));

  console.log(`Computing features for ${rendered.length} renders …`);
  const entries = await mapPool(rendered, 8, async (name) => {
    const features = await computeFeatures(join(rendersDir, `${name}.png`));
    return [name, features] as const;
  });
  const features = Object.fromEntries(
    entries.sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  await writeFile(
    join(outDir, "features.json"),
    JSON.stringify({ featureVersion: FEATURE_VERSION, features }, null, 2),
  );

  // Family grouping over the annotatable (non-deprecated base) symbols.
  const names = annotatableSymbols(catalog);
  const families = buildFamilies(names);
  await writeFile(
    join(outDir, "families.json"),
    JSON.stringify(
      Object.fromEntries(
        [...families.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      null,
      2,
    ),
  );

  const disagreements = validateAgainstFillMap(catalog.nofillToFill);
  await writeFile(
    join(outDir, "family-report.json"),
    JSON.stringify({ disagreements }, null, 2),
  );

  const multiMember = [...families.values()].filter(
    (f) => f.members.length > 1,
  );
  console.log(
    `features: ${entries.length} symbols\n` +
      `families: ${families.size} (${multiMember.length} with >1 member)\n` +
      `fill-map disagreements: ${disagreements.length} → family-report.json`,
  );
}
