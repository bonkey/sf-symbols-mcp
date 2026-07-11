import { existsSync } from "node:fs";

export interface QueryEmbedder {
  /** Embed a search query into the semantic text space (L2-normalized). */
  embedQuery(text: string): Promise<Float32Array>;
  /** Embed a document into the semantic text space (L2-normalized). */
  embedDoc(text: string): Promise<Float32Array>;
  readonly id: string;
  readonly dims: number;
}

export const TEXT_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const TEXT_DIMS = 384;

/** BGE v1.5 query instruction prefix (documents embed raw). */
export const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
  return out;
}

/**
 * Lazy transformers.js embedder. When `localModelDir` is given (the shipped
 * data package), remote downloads are disabled — fully offline. Otherwise the
 * model is fetched into the HF cache (maintainer-side builds).
 */
export class TransformersEmbedder implements QueryEmbedder {
  readonly id = TEXT_MODEL_ID;
  readonly dims = TEXT_DIMS;
  private extractor: Promise<
    (text: string, opts: object) => Promise<{ data: Float32Array }>
  > | null = null;

  constructor(private readonly localModelDir?: string) {}

  private load() {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.localModelDir && existsSync(this.localModelDir)) {
        env.allowRemoteModels = false;
        env.localModelPath = this.localModelDir;
      }
      const extractor = await pipeline("feature-extraction", TEXT_MODEL_ID, {
        dtype: "q8",
      });
      return extractor as unknown as (
        text: string,
        opts: object,
      ) => Promise<{ data: Float32Array }>;
    })();
    return this.extractor;
  }

  private async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.embed(BGE_QUERY_PREFIX + text);
  }

  embedDoc(text: string): Promise<Float32Array> {
    return this.embed(text);
  }
}
