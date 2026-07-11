import { z } from "zod";
import type { Availability } from "@sfsmcp/schema";
import { plutilToJson } from "./plutil.js";

/**
 * Raw shapes of Apple's metadata files as emitted by `plutil -convert json`.
 * Validation is deliberately strict so that a format change in a future
 * SF Symbols release fails loudly, naming the file, instead of mis-parsing.
 */

const OsVersionValue = z.union([z.string(), z.number()]).transform(String);

const RawAvailability = z
  .object({
    iOS: OsVersionValue.optional(),
    macOS: OsVersionValue.optional(),
    tvOS: OsVersionValue.optional(),
    watchOS: OsVersionValue.optional(),
    visionOS: OsVersionValue.optional(),
  })
  .strict();

export const RawNameAvailabilitySchema = z
  .object({
    symbols: z.record(z.string(), z.string()),
    year_to_release: z.record(z.string(), RawAvailability),
  })
  .strict();
export type RawNameAvailability = z.infer<typeof RawNameAvailabilitySchema>;

export const RawLayersetAvailabilitySchema = z
  .object({
    symbols: z.record(z.string(), z.record(z.string(), z.string())),
    year_to_release: z.record(z.string(), RawAvailability),
  })
  .strict();
export type RawLayersetAvailability = z.infer<
  typeof RawLayersetAvailabilitySchema
>;

export const RawCategoriesSchema = z.array(
  z
    .object({
      key: z.string(),
      label: z.string(),
      icon: z.string().optional(),
    })
    .strict(),
);
export type RawCategories = z.infer<typeof RawCategoriesSchema>;

/** symbol -> [category keys] */
export const RawSymbolCategoriesSchema = z.record(
  z.string(),
  z.array(z.string()),
);

/** symbol -> [search keywords] (Apple-authored text; local use only) */
export const RawSymbolSearchSchema = z.record(z.string(), z.array(z.string()));

/** old name -> current name */
export const RawStringMapSchema = z.record(z.string(), z.string());

/** plain array of symbol names */
export const RawNameListSchema = z.array(z.string());

async function parseWith<T>(
  path: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const json = await plutilToJson(path);
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Unexpected format in ${label} (${path}) — Apple may have changed the schema:\n${result.error.message}`,
    );
  }
  return result.data;
}

export const parseNameAvailability = (path: string) =>
  parseWith(path, RawNameAvailabilitySchema, "name availability");
export const parseLayersetAvailability = (path: string) =>
  parseWith(path, RawLayersetAvailabilitySchema, "layerset availability");
export const parseCategories = (path: string) =>
  parseWith(path, RawCategoriesSchema, "categories");
export const parseSymbolCategories = (path: string) =>
  parseWith(path, RawSymbolCategoriesSchema, "symbol categories");
export const parseSymbolSearch = (path: string) =>
  parseWith(path, RawSymbolSearchSchema, "symbol search terms");
export const parseStringMap = (path: string, label: string) =>
  parseWith(path, RawStringMapSchema, label);
export const parseNameList = (path: string, label: string) =>
  parseWith(path, RawNameListSchema, label);

/** Availability normalized to the schema type (values already strings). */
export const toAvailability = (
  raw: z.infer<typeof RawAvailability>,
): Availability => raw;

/**
 * Parse SymbolVariantScripts.csv ("Script,Extension" header, e.g. "Arabic,ar").
 * Returns the set of name-suffix extensions marking localized script variants.
 */
export function parseVariantScriptsCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [script, ext] = line.split(",").map((s) => s.trim());
    if (script && ext) map.set(ext, script);
  }
  return map;
}

/**
 * Fallback script-suffix set for degraded mode (no SF Symbols app installed).
 * These are the script extensions observed in actual symbol names; the CSV is
 * preferred when available.
 */
export const FALLBACK_SCRIPT_EXTENSIONS = new Map<string, string>([
  ["ar", "Arabic"],
  ["bn", "Bangla"],
  ["el", "Greek"],
  ["gu", "Gujarati"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["km", "Khmer"],
  ["kn", "Kannada"],
  ["ko", "Korean"],
  ["ml", "Malayalam"],
  ["mr", "Marathi"],
  ["my", "Burmese"],
  ["or", "Odia"],
  ["pa", "Punjabi"],
  ["ru", "Russian"],
  ["si", "Sinhala"],
  ["ta", "Tamil"],
  ["te", "Telugu"],
  ["th", "Thai"],
  ["zh", "Chinese"],
]);
