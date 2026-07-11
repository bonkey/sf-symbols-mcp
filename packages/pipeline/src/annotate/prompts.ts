/**
 * Versioned prompts for the vision annotation passes. The version is part of
 * every custom_id and stored annotation — bump it when the wording changes,
 * and only re-annotate what the new version requires.
 */

export const PROMPT_VERSIONS = {
  pass1: "1",
  pass1b: "1", // alternate phrasing used for the consensus re-run
  pass2: "1",
  pass3: "1",
  family: "1",
} as const;

export const PASS1_SYSTEM = `You are a precise visual analyst describing user-interface icons. You describe ONLY what is literally visible in the image. You never guess what the icon is "for", never name the icon, and never mention brands or products. Vocabulary: use simple object nouns (arrow, tray, bell, circle, document, person, cloud, gear...), directions, and spatial relations.`;

export const PASS1_PROMPT = `Analyze this monochrome user-interface icon image.

Describe ONLY the visible content:
- primaryObjects: the main shapes/objects, most visually dominant first
- secondaryObjects: smaller or supporting shapes
- directions: any directions expressed by arrows, chevrons, or motion (use the provided enum)
- spatialRelations: short phrases like "arrow enters tray", "line crosses bell diagonally"
- modifiers: visual modifications such as "diagonal strike-through line", "filled silhouette", "dashed outline"
- badges: small attached marks (e.g. "plus sign badge in corner")
- enclosure: the shape enclosing the main content, or "none"
- impliedMotion: motion the composition implies, e.g. "movement downward into container"
- literalDescription: one or two sentences describing exactly what is visible
- confidence: 0-1, how certain you are that your literal reading is correct

Do NOT infer the icon's purpose or meaning. Describe only what you see.`;

export const PASS1B_PROMPT = `Look carefully at this black-and-white interface glyph.

List, strictly from what is drawn in the pixels (no interpretation of purpose):
- primaryObjects (dominant shapes first), secondaryObjects
- directions shown by any arrow/chevron/rotation (enum values only)
- spatialRelations between the shapes (short phrases)
- modifiers (strike-through, fill, dashes, partial shapes)
- badges (small corner marks)
- enclosure (surrounding shape or "none")
- impliedMotion
- literalDescription: 1-2 plain sentences of what is drawn
- confidence 0-1

Never state what the glyph is used for. Only what is visible.`;

export const PASS2_SYSTEM = `You are a UI/UX expert who interprets icon imagery. Given a literal description of an interface icon (and the image), you enumerate the UI meanings a designer could intend. You think in terms of common desktop and mobile conventions. You do not know the icon's name.`;

export const PASS2_PROMPT = (literalJson: string) => `A vision analyst produced this literal description of the attached interface icon:

${literalJson}

Interpret the possible UI meanings:
- likelyActions: verbs a UI would use this icon for, most likely first (e.g. "download", "share", "delete", "mute")
- likelyObjects: things the icon likely represents or acts upon (e.g. "document", "message", "notification")
- uiContexts: where such an icon typically appears (e.g. "toolbar", "tab bar", "context menu", "status indicator")
- metaphors: the visual metaphors at work (e.g. "arrow down = receiving", "tray = inbox/container")
- ambiguities: plausible misreadings or competing interpretations, phrased as short sentences
- semanticConfidence: 0-1

Ground every interpretation in the visible content; do not invent details not present in the description or image.`;

export const PASS3_SYSTEM = `You are auditing icon annotations for a search engine over Apple's SF Symbols catalog. You receive an icon image, its official symbol name, catalog metadata, and two prior analyses done WITHOUT the name. Your job is reconciliation: verify, correct, and enrich — never silently merge contradictions.`;

export const PASS3_PROMPT = (args: {
  name: string;
  metadataJson: string;
  pass1Json: string;
  pass2Json: string;
}) => `Official symbol name: ${args.name}

Catalog metadata:
${args.metadataJson}

Blind literal analysis (pass 1):
${args.pass1Json}

Blind semantic interpretation (pass 2):
${args.pass2Json}

Reconcile against the attached image:
- nameGlyphConsistent: does the name plausibly describe the visible glyph?
- hallucinationFlags: elements the prior analyses claimed but that are NOT visible (empty if none)
- minedAliases: additional search words/phrases a developer might type to find this symbol (informed by name + glyph; lowercase; no duplicates of the name tokens)
- contradictions: conflicts between the name/metadata and the blind analyses — record each as {field, observed, expected, note}; do NOT resolve them silently
- finalDescription: your best one-or-two-sentence description of the glyph, correcting any errors
- confidence: 0-1 for the final reconciled record`;

export const FAMILY_SYSTEM = `You are documenting families of related SF Symbols variants for a symbol search engine. You receive the family's member names and per-member glyph descriptions. Describe the shared concept and each member's role. You never invent member names.`;

export const FAMILY_PROMPT = (args: {
  baseName: string;
  membersJson: string;
}) => `Symbol family "${args.baseName}" has these members (name + reconciled glyph description):

${args.membersJson}

Produce:
- baseConcept: one sentence for the shared base object/idea of this family
- memberRoles: for EVERY member name given above (keys must match exactly), {modifiers: visual modifier tokens (e.g. ["fill"], ["slash"], ["badge.plus"]), stateRelation: what UI state/variation it expresses relative to the base (e.g. "filled/selected state", "disabled/off state", "with notification badge"), note: optional caveat}
- disambiguationNotes: short sentences helping a developer pick between confusable members (empty if trivial)`;
