import actionsLexicon from "./lexicon/actions.json" with { type: "json" };
import objectsLexicon from "./lexicon/objects.json" with { type: "json" };
import conventions from "./lexicon/ui-conventions.json" with { type: "json" };

export interface ActionEntry {
  metaphors: string[];
  antonyms: string[];
}

const ACTIONS = actionsLexicon.actions as Record<string, ActionEntry>;
const SYNONYMS = actionsLexicon.synonyms as Record<string, string>;
const OBJECTS = objectsLexicon as Record<string, string[]>;
export const UI_CONVENTIONS = conventions as Record<
  string,
  { symbol: string; prior: number }[]
>;

const DIRECTIONS = new Set([
  "up",
  "down",
  "left",
  "right",
  "forward",
  "backward",
  "clockwise",
  "counterclockwise",
]);

/**
 * Auxiliary display verbs: too generic to define the icon's action
 * ("show an error", "open the chat"). They never become primaryAction —
 * the accompanying noun carries the intent.
 */
const GENERIC_VERBS = new Set(["show", "open", "view", "display", "go", "see"]);

/** Light suffix stemmer — precision over recall (full Porter over-stems "settings"→"set"). */
export function lightStem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Resolve a verb-ish token (or two-word phrase like "sign out") to its canonical action. */
export function canonicalAction(word: string): string | null {
  const lower = word.toLowerCase().trim();
  const candidates = [lower, lightStem(lower)];
  if (/[\s-]/.test(lower)) {
    const joined = lower.replaceAll(/[\s-]+/g, "");
    candidates.push(joined, lightStem(joined));
  }
  for (const candidate of candidates) {
    if (ACTIONS[candidate]) return candidate;
    const viaSynonym = SYNONYMS[candidate];
    if (viaSynonym) return viaSynonym;
  }
  return null;
}

/** Convention keys reachable from a token pair ("dark mode" -> "dark-mode"/"darkmode"). */
export function bigramKeys(a: string, b: string): string[] {
  return [`${a}-${b}`, `${a}${b}`];
}

export function actionEntry(canonical: string): ActionEntry | null {
  return ACTIONS[canonical] ?? null;
}

/** Symbol-vocabulary tokens for a noun, if known. */
export function objectVocabulary(word: string): string[] {
  const lower = word.toLowerCase();
  return OBJECTS[lower] ?? OBJECTS[lightStem(lower)] ?? [];
}

export interface Decomposition {
  primaryAction?: string;
  objects: string[];
  direction?: string;
  negatedTerms: string[];
  /** Expansion terms harvested from the lexicons, for the FTS query. */
  expansionTerms: string[];
}

/**
 * Rule-based fallback decomposer for plain-string queries. When the calling
 * LLM supplies structured fields they take precedence; this also runs on top
 * of structured input to canonicalize values.
 */
export function decompose(query: string): Decomposition {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  let primaryAction: string | undefined;
  const objects: string[] = [];
  let direction: string | undefined;
  const negatedTerms: string[] = [];
  const expansionTerms: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;

    // "no/not/without X" → negated metaphor
    if ((word === "no" || word === "not" || word === "without") && words[i + 1]) {
      negatedTerms.push(words[i + 1] as string);
      continue;
    }

    if (!direction && DIRECTIONS.has(word)) direction = word;

    if (!primaryAction && !GENERIC_VERBS.has(word)) {
      // Two-word phrases first ("sign out", "dark mode"), then single tokens.
      const next = words[i + 1];
      const action =
        (next ? canonicalAction(`${word} ${next}`) : null) ??
        canonicalAction(word);
      if (action) {
        primaryAction = action;
        continue;
      }
    }

    const vocab = objectVocabulary(word);
    if (vocab.length > 0) {
      objects.push(word);
      expansionTerms.push(...vocab.flatMap((v) => v.split(" ")));
    }
  }

  if (primaryAction) {
    const entry = ACTIONS[primaryAction];
    if (entry) {
      expansionTerms.push(
        primaryAction,
        ...entry.metaphors.flatMap((m) => m.split(" ")),
      );
    }
  }

  return {
    ...(primaryAction !== undefined && { primaryAction }),
    objects,
    ...(direction !== undefined && { direction }),
    negatedTerms,
    expansionTerms: [...new Set(expansionTerms)],
  };
}
