import type { SymbolAnnotations } from "@sfsmcp/schema";

/**
 * Text-document composition for the two per-symbol text embedding spaces.
 * Kept separable on purpose: "what it does" (semantic) vs "what it looks
 * like" (visual description) get their own vectors and ranking weights.
 */

export function nameToWords(name: string): string {
  return name.split(".").filter((t) => t !== "and").join(" ");
}

/** Function-oriented document: name + actions + contexts + mined aliases. */
export function semanticDoc(
  name: string,
  categories: string[],
  annotations?: SymbolAnnotations,
): string {
  const parts = [nameToWords(name)];
  const reconciled = annotations?.reconciled?.value;
  const semantic = annotations?.semantic?.value;
  if (reconciled?.minedAliases.length) {
    parts.push(reconciled.minedAliases.join(", "));
  }
  if (semantic?.likelyActions.length) {
    parts.push(`actions: ${semantic.likelyActions.join(", ")}`);
  }
  if (semantic?.likelyObjects.length) {
    parts.push(`objects: ${semantic.likelyObjects.join(", ")}`);
  }
  if (semantic?.uiContexts.length) {
    parts.push(`used in: ${semantic.uiContexts.join(", ")}`);
  }
  if (categories.length) {
    parts.push(`category: ${categories.join(", ")}`);
  }
  return parts.join(". ");
}

/** Appearance-oriented document: literal description + visible structure. */
export function visualDoc(annotations?: SymbolAnnotations): string | null {
  const literal = annotations?.literal?.value;
  const reconciled = annotations?.reconciled?.value;
  if (!literal && !reconciled) return null;
  const parts: string[] = [];
  if (reconciled?.finalDescription) {
    parts.push(reconciled.finalDescription);
  } else if (literal?.literalDescription) {
    parts.push(literal.literalDescription);
  }
  if (literal) {
    const shows = [
      ...literal.primaryObjects,
      ...literal.spatialRelations,
      ...literal.modifiers,
    ];
    if (shows.length) parts.push(`shows: ${shows.join(", ")}`);
  }
  return parts.join(". ");
}
