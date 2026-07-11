import type { CatalogStore, SymbolRecord } from "../store/catalog-store.js";
import { compareOsVersions } from "./availability.js";

interface SymbolCard {
  name: string;
  baseName: string;
  modifiers: string[];
  availability: SymbolRecord["availability"];
  categories: string[];
  restricted: boolean;
  restrictionSubject?: string;
  description?: string;
  likelyActions?: string[];
  uiContexts?: string[];
  ambiguities?: string[];
}

interface PairwiseDiff {
  pair: [string, string];
  sameFamily: boolean;
  sharedActions: string[];
  visualSimilarity?: number;
  availabilityDelta?: string;
}

export interface CompareResponse {
  symbols: SymbolCard[];
  differences: PairwiseDiff[];
  recommendations: string[];
  notes: string[];
}

function toCard(record: SymbolRecord): SymbolCard {
  const literal = record.annotations?.literal?.value;
  const semantic = record.annotations?.semantic?.value;
  const reconciled = record.annotations?.reconciled?.value;
  return {
    name: record.name,
    baseName: record.baseName,
    modifiers: record.modifiers,
    availability: record.availability,
    categories: record.categories,
    restricted: record.restricted,
    ...(record.restrictionSubject !== undefined && {
      restrictionSubject: record.restrictionSubject,
    }),
    ...(reconciled?.finalDescription !== undefined
      ? { description: reconciled.finalDescription }
      : literal?.literalDescription !== undefined && {
          description: literal.literalDescription,
        }),
    ...(semantic?.likelyActions !== undefined && {
      likelyActions: semantic.likelyActions,
    }),
    ...(semantic?.uiContexts !== undefined && { uiContexts: semantic.uiContexts }),
    ...(semantic?.ambiguities !== undefined && {
      ambiguities: semantic.ambiguities,
    }),
  };
}

function visualCosine(
  store: CatalogStore,
  nameA: string,
  nameB: string,
): number | undefined {
  const matrix = store.matrix("embedding_visual");
  if (!matrix) return undefined;
  const rowA = matrix.names.indexOf(nameA);
  const rowB = matrix.names.indexOf(nameB);
  if (rowA < 0 || rowB < 0) return undefined;
  let dot = 0;
  for (let i = 0; i < matrix.dims; i++) {
    dot +=
      (matrix.vectors[rowA * matrix.dims + i] as number) *
      (matrix.vectors[rowB * matrix.dims + i] as number);
  }
  return Number(dot.toFixed(3));
}

/** Structured diff of 2-6 candidate symbols for one UI function. */
export function compareSymbols(
  store: CatalogStore,
  names: string[],
): CompareResponse {
  const notes: string[] = [];
  const records: SymbolRecord[] = [];
  for (const name of names) {
    const record =
      store.getSymbol(name) ?? store.getSymbol(store.resolveAlias(name) ?? "");
    if (!record) {
      notes.push(`\`${name}\` is not an SF Symbol name — skipped.`);
      continue;
    }
    if (record.name !== name) {
      notes.push(`\`${name}\` resolves to \`${record.name}\`.`);
    }
    records.push(record);
  }

  const differences: PairwiseDiff[] = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i] as SymbolRecord;
      const b = records[j] as SymbolRecord;
      const actionsA = new Set(
        a.annotations?.semantic?.value.likelyActions ?? [],
      );
      const sharedActions = (
        b.annotations?.semantic?.value.likelyActions ?? []
      ).filter((x) => actionsA.has(x));

      let availabilityDelta: string | undefined;
      const iosA = a.availability.iOS;
      const iosB = b.availability.iOS;
      if (iosA && iosB && iosA !== iosB) {
        const newer = compareOsVersions(iosA, iosB) > 0 ? a : b;
        availabilityDelta = `\`${newer.name}\` needs iOS ${newer.availability.iOS}+ (the other is available earlier)`;
      }

      const visualSimilarity = visualCosine(store, a.name, b.name);
      differences.push({
        pair: [a.name, b.name],
        sameFamily: a.baseName === b.baseName,
        sharedActions,
        ...(visualSimilarity !== undefined && { visualSimilarity }),
        ...(availabilityDelta !== undefined && { availabilityDelta }),
      });
    }
  }

  const recommendations: string[] = [];
  for (const record of records) {
    const semantic = record.annotations?.semantic?.value;
    const parts: string[] = [];
    if (semantic?.likelyActions.length) {
      parts.push(`reads as "${semantic.likelyActions.slice(0, 3).join('", "')}"`);
    }
    if (semantic?.uiContexts.length) {
      parts.push(`conventional in ${semantic.uiContexts.slice(0, 2).join(", ")}`);
    }
    if (record.restricted) {
      parts.push(
        `RESTRICTED${record.restrictionSubject ? ` to ${record.restrictionSubject}` : ""}`,
      );
    }
    if (record.modifiers.length > 0) {
      parts.push(`variant of \`${record.baseName}\` (${record.modifiers.join("+")})`);
    }
    if (parts.length > 0) {
      recommendations.push(`\`${record.name}\`: ${parts.join("; ")}.`);
    }
  }
  if (records.some((r) => r.unannotated)) {
    notes.push(
      "Some symbols have no visual annotations yet — semantic comparison is limited to catalog metadata.",
    );
  }

  return {
    symbols: records.map(toCard),
    differences,
    recommendations,
    notes,
  };
}
