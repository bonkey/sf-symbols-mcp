import type { CatalogStore } from "../store/catalog-store.js";

export interface SimilarResult {
  name: string;
  similarity: number;
  sharedTraits: string[];
}

function hamming(hashA: string, hashB: string): number {
  let diff = BigInt(`0x${hashA}`) ^ BigInt(`0x${hashB}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * Visual similarity: CLIP image-vector cosine leads (shape gestalt), pHash
 * catches near-duplicates, plus catalog-structure bonuses. Same-family
 * members are excluded by default (trivially similar).
 */
export function findVisuallySimilar(
  store: CatalogStore,
  name: string,
  opts: {
    limit?: number;
    method?: "embedding" | "phash" | "hybrid";
    excludeSameFamily?: boolean;
  } = {},
): { results: SimilarResult[]; note?: string } {
  const limit = opts.limit ?? 10;
  const method = opts.method ?? "hybrid";
  const excludeFamily = opts.excludeSameFamily ?? true;

  const anchor =
    store.getSymbol(name) ??
    store.getSymbol(store.resolveAlias(name) ?? "");
  if (!anchor) {
    return { results: [], note: `\`${name}\` is not an SF Symbol name.` };
  }

  const matrix = store.matrix("embedding_visual");
  const anchorRowIndex = matrix?.names.indexOf(anchor.name) ?? -1;
  const anchorVector =
    matrix && anchorRowIndex >= 0
      ? matrix.vectors.subarray(
          anchorRowIndex * matrix.dims,
          (anchorRowIndex + 1) * matrix.dims,
        )
      : null;

  if (!anchorVector && method === "embedding") {
    return {
      results: [],
      note: "No visual embeddings in this catalog build.",
    };
  }

  const anchorObjects = new Set(
    anchor.annotations?.literal?.value.primaryObjects.map((o) =>
      o.toLowerCase(),
    ) ?? [],
  );
  const anchorBaseToken = anchor.baseName.split(".")[0] as string;

  const scores: SimilarResult[] = [];
  const candidateNames = matrix?.names ?? [];
  for (let row = 0; row < candidateNames.length; row++) {
    const candidateName = candidateNames[row] as string;
    if (candidateName === anchor.name) continue;
    const candidate = store.getSymbol(candidateName);
    if (!candidate || candidate.deprecated) continue;
    if (excludeFamily && candidate.baseName === anchor.baseName) continue;

    let visualCos = 0;
    if (anchorVector && matrix) {
      const offset = row * matrix.dims;
      for (let i = 0; i < matrix.dims; i++) {
        visualCos +=
          (matrix.vectors[offset + i] as number) * (anchorVector[i] as number);
      }
      visualCos = Math.max(0, visualCos);
    }

    let phashSim = 0;
    if (anchor.phash && candidate.phash) {
      phashSim = 1 - hamming(anchor.phash, candidate.phash) / 64;
    }

    const sharedTraits: string[] = [];
    let sharedObject = 0;
    if (anchorObjects.size > 0) {
      const candidateObjects =
        candidate.annotations?.literal?.value.primaryObjects ?? [];
      const shared = candidateObjects.filter((o) =>
        anchorObjects.has(o.toLowerCase()),
      );
      if (shared.length > 0) {
        sharedObject = 1;
        sharedTraits.push(`both show: ${shared.join(", ")}`);
      }
    }
    let familyRelation = 0;
    if (candidate.baseName === anchor.baseName) {
      familyRelation = 1;
      sharedTraits.push("same family");
    } else if (candidate.baseName.split(".")[0] === anchorBaseToken) {
      familyRelation = 0.5;
      sharedTraits.push(`shared base "${anchorBaseToken}"`);
    }
    if (phashSim > 0.8) sharedTraits.push("near-identical silhouette");

    const similarity =
      method === "embedding"
        ? visualCos
        : method === "phash"
          ? phashSim
          : 0.55 * visualCos +
            0.25 * phashSim +
            0.1 * sharedObject +
            0.1 * familyRelation;

    scores.push({
      name: candidateName,
      similarity: Number(similarity.toFixed(4)),
      sharedTraits,
    });
  }

  scores.sort((a, b) => b.similarity - a.similarity);
  return { results: scores.slice(0, limit) };
}
