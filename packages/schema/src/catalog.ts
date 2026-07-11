import { z } from "zod";

/** Apple platforms a symbol can be available on. */
export const PLATFORMS = ["iOS", "macOS", "tvOS", "watchOS", "visionOS"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

/** Marketing OS version like "13.0" or "26.1". */
export const OsVersionSchema = z.string().regex(/^\d+(\.\d+)*$/);

/** SF Symbol identifiers use lowercase latin, digits, and dots ("tray.and.arrow.down", "square.grid.3x3"). */
export const SymbolNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9.]*$/, "not a plausible SF Symbol name");
export type SymbolName = z.infer<typeof SymbolNameSchema>;

/** Minimum OS version per platform. A missing platform means "not available there". */
export const AvailabilitySchema = z.object({
  iOS: OsVersionSchema.optional(),
  macOS: OsVersionSchema.optional(),
  tvOS: OsVersionSchema.optional(),
  watchOS: OsVersionSchema.optional(),
  visionOS: OsVersionSchema.optional(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/** Script-localized variant of a base symbol (e.g. "character.book.closed.ar"). */
export const LocalizedVariantSchema = z.object({
  name: SymbolNameSchema,
  script: z.string(),
});

export const AliasKindSchema = z.enum([
  /** From name_aliases: old name renamed to a current one. */
  "rename",
  /** From legacy_aliases: very old name. */
  "legacy",
  /** From semantic_to_descriptive_name: UIKit-style semantic name ("play" -> "play.fill"). */
  "semantic",
  /** Mined by the vision reconciliation pass; independently authored. */
  "mined",
]);
export type AliasKind = z.infer<typeof AliasKindSchema>;

export const AliasSchema = z.object({
  alias: z.string().min(1),
  canonical: SymbolNameSchema,
  kind: AliasKindSchema,
});
export type Alias = z.infer<typeof AliasSchema>;

/**
 * One base symbol as extracted from the local SF Symbols installation.
 * Localized script variants are folded into their base symbol.
 *
 * Fields marked APPLE-AUTHORED TEXT are never shipped in published packages;
 * they exist only in local extractions (see the licensing policy in the plan).
 */
export const ExtractedSymbolSchema = z.object({
  name: SymbolNameSchema,
  /** Apple's release token, e.g. "2019", "2023.2". */
  yearToken: z.string(),
  availability: AvailabilitySchema,
  categories: z.array(z.string()).default([]),
  /** APPLE-AUTHORED TEXT: in-app search keywords. Local-only. */
  appleSearchTerms: z.array(z.string()).default([]),
  /** Rendering-mode (layerset) availability, e.g. { hierarchical: {iOS:"15.0",...} }. */
  layersets: z.record(z.string(), AvailabilitySchema).default({}),
  restricted: z.boolean().default(false),
  /** APPLE-AUTHORED TEXT: full restriction sentence. Local-only. */
  restrictionText: z.string().optional(),
  /** The Apple product/feature the restriction refers to (our own factual extraction; shippable). */
  restrictionSubject: z.string().optional(),
  rtlFlippable: z.boolean().default(false),
  localizedVariants: z.array(LocalizedVariantSchema).default([]),
  /** Position in Apple's canonical display order, if known. */
  sortOrder: z.number().int().optional(),
});
export type ExtractedSymbol = z.infer<typeof ExtractedSymbolSchema>;

export const CategorySchema = z.object({
  key: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});

/** Output of the extractor: everything read from a local SF Symbols installation. */
export const ExtractedCatalogSchema = z.object({
  sfSymbolsVersion: z.string(),
  sfSymbolsBuild: z.string().optional(),
  extractedAt: z.string(),
  source: z.enum(["sf-symbols-app", "coreglyphs-bundle"]),
  yearToRelease: z.record(z.string(), AvailabilitySchema),
  categories: z.array(CategorySchema),
  symbols: z.array(ExtractedSymbolSchema),
  aliases: z.array(AliasSchema),
  /** outline -> filled counterpart, from nofill_to_fill. */
  nofillToFill: z.record(z.string(), z.string()),
});
export type ExtractedCatalog = z.infer<typeof ExtractedCatalogSchema>;
