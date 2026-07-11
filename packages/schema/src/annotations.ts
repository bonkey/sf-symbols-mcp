import { z } from "zod";
import { SymbolNameSchema } from "./catalog.js";

export const ProvenanceSchema = z.object({
  source: z.enum(["vision-model", "computed", "apple", "curated"]),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  batchId: z.string().optional(),
  requestId: z.string().optional(),
  timestamp: z.string().optional(),
  featureVersion: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DirectionSchema = z.enum([
  "up",
  "down",
  "left",
  "right",
  "up-left",
  "up-right",
  "down-left",
  "down-right",
  "clockwise",
  "counterclockwise",
  "inward",
  "outward",
]);
export type Direction = z.infer<typeof DirectionSchema>;

export const EnclosureSchema = z.enum([
  "circle",
  "square",
  "rectangle",
  "capsule",
  "diamond",
  "shield",
  "seal",
  "triangle",
  "none",
]);
export type Enclosure = z.infer<typeof EnclosureSchema>;

/** Pass 1: literal, image-only decomposition. Describes ONLY what is visible. */
export const Pass1LiteralSchema = z.object({
  primaryObjects: z.array(z.string()),
  secondaryObjects: z.array(z.string()),
  directions: z.array(DirectionSchema),
  spatialRelations: z.array(z.string()),
  modifiers: z.array(z.string()),
  badges: z.array(z.string()),
  enclosure: EnclosureSchema,
  impliedMotion: z.array(z.string()),
  literalDescription: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Pass1Literal = z.infer<typeof Pass1LiteralSchema>;

/** Pass 2: semantic interpretation of the literal description (still no symbol name). */
export const Pass2SemanticSchema = z.object({
  likelyActions: z.array(z.string()),
  likelyObjects: z.array(z.string()),
  uiContexts: z.array(z.string()),
  metaphors: z.array(z.string()),
  ambiguities: z.array(z.string()),
  semanticConfidence: z.number().min(0).max(1),
});
export type Pass2Semantic = z.infer<typeof Pass2SemanticSchema>;

/**
 * Lenient result-validation variant of Pass1LiteralSchema: structured outputs
 * carry the enum constraints only as prose (the SDK moves enums into the
 * description), so the model occasionally emits near-miss values. Unknown
 * directions are dropped; unknown enclosures fall back to "none". Checkpoints
 * store the normalized value, so downstream readers can stay strict.
 */
export const Pass1LiteralWireSchema = Pass1LiteralSchema.extend({
  directions: z
    .array(z.string())
    .transform((arr) =>
      arr.filter((d): d is Direction =>
        (DirectionSchema.options as readonly string[]).includes(d),
      ),
    ),
  enclosure: z
    .string()
    .transform((v): Enclosure =>
      (EnclosureSchema.options as readonly string[]).includes(v)
        ? (v as Enclosure)
        : "none",
    ),
});

export const ContradictionSchema = z.object({
  field: z.string(),
  observed: z.string(),
  expected: z.string(),
  note: z.string().optional(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

/** Pass 3: reconciliation with the symbol name + Apple metadata. */
export const Pass3ReconcileSchema = z.object({
  nameGlyphConsistent: z.boolean(),
  hallucinationFlags: z.array(z.string()),
  minedAliases: z.array(z.string()),
  contradictions: z.array(ContradictionSchema),
  finalDescription: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Pass3Reconcile = z.infer<typeof Pass3ReconcileSchema>;

export const MemberRoleSchema = z.object({
  modifiers: z.array(z.string()),
  stateRelation: z.string().optional(),
  note: z.string().optional(),
});

/** Family-level analysis over a deterministically computed family. */
export const FamilyAnalysisSchema = z.object({
  baseConcept: z.string(),
  memberRoles: z.record(SymbolNameSchema, MemberRoleSchema),
  disambiguationNotes: z.array(z.string()),
});
export type FamilyAnalysis = z.infer<typeof FamilyAnalysisSchema>;

/** Cheap, conventional image-processing features of the normalized render. */
export const DeterministicFeaturesSchema = z.object({
  inkDensity: z.number(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  aspectRatio: z.number(),
  connectedComponents: z.number().int(),
  symmetryH: z.number(),
  symmetryV: z.number(),
  complexity: z.number(),
  /** 0 = fully outlined, 1 = fully filled appearance. */
  fillScore: z.number(),
  /** 64-bit perceptual hash, 16 hex chars. */
  phash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type DeterministicFeatures = z.infer<typeof DeterministicFeaturesSchema>;

const withProvenance = <T extends z.ZodType>(value: T) =>
  z.object({ value, provenance: ProvenanceSchema });

/** Everything we know about one symbol beyond Apple metadata; the shippable annotation record. */
export const SymbolAnnotationsSchema = z.object({
  name: SymbolNameSchema,
  literal: withProvenance(Pass1LiteralSchema).optional(),
  semantic: withProvenance(Pass2SemanticSchema).optional(),
  reconciled: withProvenance(Pass3ReconcileSchema).optional(),
  features: withProvenance(DeterministicFeaturesSchema).optional(),
  /** Set when consensus passes disagreed; both raw outputs are preserved in the pipeline checkpoints. */
  disagreement: z.boolean().default(false),
});
export type SymbolAnnotations = z.infer<typeof SymbolAnnotationsSchema>;
