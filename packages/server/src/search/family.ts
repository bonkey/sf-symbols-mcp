/**
 * Symbol family model: compute a family key (base name) by stripping
 * PRESENTATION modifiers from the right of a symbol name until fixpoint.
 *
 * Stripped (presentation): .fill, .slash, .badge[.<content>…], trailing
 * enclosures (circle/square/…) when a base remains, trailing pure-number
 * count tokens.
 *
 * NOT stripped (semantic, they define different families): directional
 * tokens (arrow.down is its own family), `and.<x>` compositions
 * (tray.and.arrow.down ≠ tray), and leading shape bases (circle.grid.3x3
 * keeps circle — enclosures only strip when a non-empty base remains left).
 */

export const ENCLOSURES = new Set([
  "circle",
  "square",
  "rectangle",
  "capsule",
  "diamond",
  "shield",
  "seal",
]);

/** Tokens that connect two semantic objects; an enclosure token right after one is an object, not an enclosure ("square.on.circle"). */
const CONNECTORS = new Set(["and", "on", "in"]);

export interface FamilyKey {
  baseName: string;
  /** Stripped modifiers, outermost-first (strip order), e.g. ["fill", "badge.plus"]. */
  modifiers: string[];
}

/** Compute the family key for a symbol name. Pure name grammar, no catalog needed. */
export function computeFamilyKey(name: string): FamilyKey {
  let tokens = name.split(".");
  const modifiers: string[] = [];

  // "fill" is presentational wherever it appears, including inside
  // compositions ("square.fill.on.circle.fill" -> square.on.circle).
  if (tokens.length > 1 && tokens.includes("fill")) {
    tokens = tokens.filter((t) => t !== "fill");
    modifiers.push("fill");
  }

  for (;;) {
    const last = tokens.at(-1);
    if (last === undefined || tokens.length < 2) break;

    if (last === "slash") {
      modifiers.push(last);
      tokens = tokens.slice(0, -1);
      continue;
    }

    // Rightmost "badge" at index >= 1 strips badge plus its content tokens
    // ("bell.badge", "app.badge.checkmark", "person.crop.circle.badge.plus").
    const badgeIndex = tokens.lastIndexOf("badge");
    if (badgeIndex >= 1) {
      modifiers.push(tokens.slice(badgeIndex).join("."));
      tokens = tokens.slice(0, badgeIndex);
      continue;
    }

    // Trailing enclosure with a non-empty base to its left — unless it
    // follows a connector, where it is a composed object ("square.on.circle").
    if (
      ENCLOSURES.has(last) &&
      !CONNECTORS.has(tokens.at(-2) ?? "")
    ) {
      modifiers.push(last);
      tokens = tokens.slice(0, -1);
      continue;
    }

    // Trailing pure-number count token ("tray.2").
    if (/^\d+$/.test(last)) {
      modifiers.push(last);
      tokens = tokens.slice(0, -1);
      continue;
    }

    break;
  }

  return { baseName: tokens.join("."), modifiers };
}

export interface Family {
  baseName: string;
  /** Members sorted: representative first. */
  members: string[];
  /** The member used to represent the family in search results. */
  representative: string;
}

/**
 * Group symbol names into families. The representative is the plain base
 * symbol when it exists, otherwise the shortest member (ties: lexicographic).
 */
export function buildFamilies(names: Iterable<string>): Map<string, Family> {
  const byBase = new Map<string, string[]>();
  for (const name of names) {
    const { baseName } = computeFamilyKey(name);
    const list = byBase.get(baseName) ?? [];
    list.push(name);
    byBase.set(baseName, list);
  }

  const families = new Map<string, Family>();
  for (const [baseName, members] of byBase) {
    members.sort(
      (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    );
    const representative = members.includes(baseName) ? baseName : members[0]!;
    const ordered = [
      representative,
      ...members.filter((m) => m !== representative),
    ];
    families.set(baseName, {
      baseName,
      members: ordered,
      representative,
    });
  }
  return families;
}

/**
 * Cross-check the grammar against Apple's outline->fill ground truth:
 * both sides of every pair must land in the same family. Returns the
 * disagreeing pairs for maintainer review.
 */
export function validateAgainstFillMap(
  nofillToFill: Record<string, string>,
): { outline: string; fill: string; outlineBase: string; fillBase: string }[] {
  const disagreements: {
    outline: string;
    fill: string;
    outlineBase: string;
    fillBase: string;
  }[] = [];
  for (const [outline, fill] of Object.entries(nofillToFill)) {
    const outlineBase = computeFamilyKey(outline).baseName;
    const fillBase = computeFamilyKey(fill).baseName;
    if (outlineBase !== fillBase) {
      disagreements.push({ outline, fill, outlineBase, fillBase });
    }
  }
  return disagreements;
}
