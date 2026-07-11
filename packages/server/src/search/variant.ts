import type { CatalogStore } from "../store/catalog-store.js";
import { meetsAvailability } from "./availability.js";
import { computeFamilyKey } from "./family.js";
import type { ResolveVariantInput } from "./schema.js";

export interface VariantResolution {
  resolved: string;
  exists: boolean;
  appliedModifiers: string[];
  note?: string;
  nearestAlternatives: { name: string; modifiers: string[]; missing: string[] }[];
  familyMembers: string[];
}

/**
 * Decision table (first match per axis; axes compose):
 * - explicit state flags always win
 * - semantics: notification -> badge, add -> badge.plus, remove -> badge.minus,
 *   containment -> circle, prominent button -> fill
 * - conventions: selected tab bar on iOS -> fill; watchOS -> fill;
 *   macOS toolbar/sidebar -> outline
 * Every resolution is validated against the catalog — never fabricate a name.
 */
export function desiredModifiers(input: ResolveVariantInput): {
  modifiers: string[];
  rationale: string[];
} {
  const modifiers = new Set<string>();
  const rationale: string[] = [];

  if (input.state) {
    const { filled, slashed, badge, enclosure } = input.state;
    if (filled) modifiers.add("fill");
    if (slashed) modifiers.add("slash");
    if (badge !== undefined) modifiers.add(badge === "" ? "badge" : `badge.${badge}`);
    if (enclosure && enclosure !== "none") modifiers.add(enclosure);
    if (modifiers.size > 0) rationale.push("explicit state flags");
  }

  switch (input.semantics) {
    case "notification":
      modifiers.add("badge");
      rationale.push("notification -> badge variant");
      break;
    case "add":
      modifiers.add("badge.plus");
      rationale.push("add -> badge.plus variant");
      break;
    case "remove":
      modifiers.add("badge.minus");
      rationale.push("remove -> badge.minus variant");
      break;
    case "containment":
      modifiers.add("circle");
      rationale.push("containment -> circle enclosure");
      break;
    case "prominent":
      modifiers.add("fill");
      rationale.push("prominent -> fill");
      break;
    case undefined:
      break;
  }

  if (
    input.selected &&
    input.uiContext === "tabBar" &&
    (input.platform === undefined || input.platform === "iOS")
  ) {
    modifiers.add("fill");
    rationale.push("selected iOS tab-bar items use .fill (HIG)");
  }
  if (input.platform === "watchOS") {
    modifiers.add("fill");
    rationale.push("watchOS prefers filled glyphs (HIG)");
  }
  if (
    input.platform === "macOS" &&
    (input.uiContext === "toolbar" || input.uiContext === "sidebar")
  ) {
    modifiers.delete("fill");
    rationale.push("macOS toolbars/sidebars prefer outline weight (HIG)");
  }

  return { modifiers: [...modifiers], rationale };
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

export function resolveVariant(
  store: CatalogStore,
  input: ResolveVariantInput,
): VariantResolution {
  const inputRecord =
    store.getSymbol(input.base) ??
    (store.resolveAlias(input.base)
      ? store.getSymbol(store.resolveAlias(input.base) as string)
      : null);
  const baseName = inputRecord
    ? inputRecord.baseName
    : computeFamilyKey(input.base).baseName;

  const family = store.family(baseName);
  if (!family) {
    return {
      resolved: input.base,
      exists: inputRecord !== null,
      appliedModifiers: [],
      note: `No family found for \`${input.base}\`; returning the input as-is.`,
      nearestAlternatives: [],
      familyMembers: inputRecord ? [inputRecord.name] : [],
    };
  }

  const { modifiers: wanted, rationale } = desiredModifiers(input);
  const members = family.members
    .map((name) => store.getSymbol(name))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter(
      (r) =>
        !input.platforms || meetsAvailability(r.availability, input.platforms),
    );

  const exact = members.find((m) => sameSet(m.modifiers, wanted));
  if (exact) {
    return {
      resolved: exact.name,
      exists: true,
      appliedModifiers: wanted,
      ...(rationale.length > 0 && { note: rationale.join("; ") }),
      nearestAlternatives: [],
      familyMembers: family.members,
    };
  }

  // No exact variant: rank members by how close their modifier set is.
  const ranked = members
    .map((m) => {
      const missing = wanted.filter((w) => !m.modifiers.includes(w));
      const extra = m.modifiers.filter((mod) => !wanted.includes(mod));
      return { m, missing, distance: missing.length + extra.length };
    })
    .sort((a, b) => a.distance - b.distance);

  const best = ranked[0];
  // The family's members list is ordered representative-first at build time.
  const fallback = best?.m.name ?? family.members[0] ?? input.base;
  return {
    resolved: fallback,
    exists: best !== undefined && best.missing.length === 0,
    appliedModifiers: best ? best.m.modifiers : [],
    note:
      `No \`${[...wanted].join("+")}\` variant exists for \`${baseName}\`` +
      (rationale.length > 0 ? ` (wanted: ${rationale.join("; ")})` : "") +
      `; closest existing variant returned.`,
    nearestAlternatives: ranked.slice(0, 3).map(({ m, missing }) => ({
      name: m.name,
      modifiers: m.modifiers,
      missing,
    })),
    familyMembers: family.members,
  };
}
