import { z } from "zod";

/** Manifest written by the extractor next to the extracted catalog JSON. */
export const ExtractionManifestSchema = z.object({
  extractorVersion: z.string(),
  sfSymbolsVersion: z.string(),
  sfSymbolsBuild: z.string().optional(),
  source: z.enum(["sf-symbols-app", "coreglyphs-bundle"]),
  sourcePaths: z.record(z.string(), z.string()),
  fileHashes: z.record(z.string(), z.string()),
  extractedAt: z.string(),
  counts: z.object({
    rawSymbols: z.number().int(),
    baseSymbols: z.number().int(),
    localizedVariants: z.number().int(),
    aliases: z.number().int(),
    restricted: z.number().int(),
  }),
});
export type ExtractionManifest = z.infer<typeof ExtractionManifestSchema>;

/** Manifest shipped inside the @sf-symbols-mcp/data package. */
export const DataManifestSchema = z.object({
  schemaVersion: z.number().int(),
  dataVersion: z.string(),
  /** "full" ships Apple-derived facts; "safe" ships only independently authored data. */
  profile: z.enum(["full", "safe"]),
  sfSymbolsVersion: z.string(),
  generatedAt: z.string(),
  embedding: z.object({
    textModel: z.string(),
    textDims: z.number().int(),
    visualModel: z.string().optional(),
    visualDims: z.number().int().optional(),
  }),
  promptVersions: z.record(z.string(), z.string()),
  annotationModel: z.string().optional(),
  counts: z.object({
    symbols: z.number().int(),
    families: z.number().int(),
    annotated: z.number().int(),
  }),
  hashes: z.record(z.string(), z.string()),
});
export type DataManifest = z.infer<typeof DataManifestSchema>;
