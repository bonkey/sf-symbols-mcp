import type { CatalogStore, SymbolRecord } from "../store/catalog-store.js";
import { topKSimilar } from "../store/catalog-store.js";
import type { QueryEmbedder } from "../embed/embedder.js";
import { meetsAvailability, compareOsVersions } from "./availability.js";
import {
  actionEntry,
  bigramKeys,
  canonicalAction,
  decompose,
  lightStem,
  objectVocabulary,
  UI_CONVENTIONS,
} from "./decompose.js";
import { buildMatch, exactNameCandidates, tokenize } from "./lexical.js";
import type { SearchInput } from "./schema.js";
import weightsConfig from "./config/ranking-weights.json" with { type: "json" };

const { weights: WEIGHTS, penalties: PENALTIES, thresholds: THRESHOLDS } =
  weightsConfig;

export interface Warning {
  type:
    | "renamed"
    | "restricted"
    | "deprecated"
    | "availability"
    | "excluded-metaphor"
    | "low-confidence"
    | "close-call"
    | "ambiguity"
    | "unannotated";
  message: string;
}

export interface VariantInfo {
  name: string;
  modifiers: string[];
}

export interface ScoreBreakdown {
  lexical: number;
  semantic: number;
  actionMatch: number;
  objectMatch: number;
  curatedPrior: number;
  visualDesc: number;
  penalties: Record<string, number>;
}

export interface SearchResult {
  name: string;
  score: number;
  reason: string;
  family: { baseName: string; variants: VariantInfo[] };
  availability: SymbolRecord["availability"];
  categories: string[];
  restricted: boolean;
  restrictionSubject?: string;
  deprecated: boolean;
  renamedTo?: string;
  unannotated?: boolean;
  description?: string;
  likelyActions?: string[];
  warnings: Warning[];
  breakdown?: ScoreBreakdown;
}

export interface SearchResponse {
  results: SearchResult[];
  warnings: Warning[];
  interpretation: {
    primaryAction?: string;
    objects: string[];
    direction?: string;
    excludedTerms: string[];
  };
  catalogVersion: string;
  totalCandidates: number;
}

interface Candidate {
  record: SymbolRecord;
  lexical: number;
  semantic: number;
  visualDesc: number;
  curatedPrior: number;
  reasons: string[];
}

const NAME_DIRECTIONS = new Set([
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
 * Two-stage retrieve-then-rerank engine: exact/alias + FTS/BM25 + embedding
 * retrieval + curated conventions, fused with a weighted linear score and
 * explicit penalties, deduped to symbol families.
 */
export class SearchEngine {
  constructor(
    private readonly store: CatalogStore,
    private readonly embedder?: QueryEmbedder,
  ) {}

  async search(input: SearchInput): Promise<SearchResponse> {
    const limit = input.limit ?? 8;
    const includeVariants = input.includeVariants ?? true;
    const explain = input.explain ?? false;
    const warnings: Warning[] = [];
    const candidates = new Map<string, Candidate>();
    const hasAnnotations = this.store.annotatedCount() > 0;

    // ---- Query understanding: caller-supplied fields win, decomposer fills gaps.
    const decomposed = decompose(
      [input.query, input.object ?? "", input.destination ?? ""].join(" "),
    );
    const primaryAction = input.primaryAction
      ? (canonicalAction(input.primaryAction) ?? input.primaryAction.toLowerCase())
      : decomposed.primaryAction;
    const direction = input.direction ?? decomposed.direction;
    const objectWords = [
      ...(input.object ? [input.object.toLowerCase()] : []),
      ...(input.destination ? [input.destination.toLowerCase()] : []),
      ...decomposed.objects,
    ];
    const objectVocab = new Set(
      objectWords.flatMap((w) => [
        w,
        ...objectVocabulary(w).flatMap((v) => v.split(" ")),
      ]),
    );
    const excludedTerms = [
      ...(input.excludedMetaphors ?? []).flatMap(tokenize),
      ...decomposed.negatedTerms,
    ];
    const action = primaryAction ? actionEntry(primaryAction) : null;
    const antonyms = new Set(action?.antonyms ?? []);

    const upsert = (
      record: SymbolRecord | null,
      patch: Partial<Omit<Candidate, "record" | "reasons">>,
      reason: string,
    ): void => {
      if (!record) return;
      if (record.deprecated) {
        if (!record.renamedTo) return;
        const canonical = this.store.getSymbol(record.renamedTo);
        if (!canonical) return;
        warnings.push({
          type: "renamed",
          message: `\`${record.name}\` was renamed to \`${record.renamedTo}\`; using the current name.`,
        });
        record = canonical;
      }
      const existing = candidates.get(record.name);
      if (existing) {
        existing.lexical = Math.max(existing.lexical, patch.lexical ?? 0);
        existing.semantic = Math.max(existing.semantic, patch.semantic ?? 0);
        existing.visualDesc = Math.max(existing.visualDesc, patch.visualDesc ?? 0);
        existing.curatedPrior = Math.max(
          existing.curatedPrior,
          patch.curatedPrior ?? 0,
        );
        existing.reasons.push(reason);
      } else {
        candidates.set(record.name, {
          record,
          lexical: patch.lexical ?? 0,
          semantic: patch.semantic ?? 0,
          visualDesc: patch.visualDesc ?? 0,
          curatedPrior: patch.curatedPrior ?? 0,
          reasons: [reason],
        });
      }
    };

    // ---- Candidate generation.
    // 1. Exact name and alias hits.
    for (const exact of exactNameCandidates(input.query)) {
      upsert(this.store.getSymbol(exact), { lexical: 1.0 }, "exact name match");
      const viaAlias = this.store.resolveAlias(exact);
      if (viaAlias) {
        upsert(
          this.store.getSymbol(viaAlias),
          { lexical: 0.95 },
          `alias of \`${exact}\``,
        );
      }
    }

    // 2. Full-text (BM25) over query + decomposition expansions.
    const { match } = buildMatch(
      [
        input.query,
        input.primaryAction ?? "",
        input.object ?? "",
        input.destination ?? "",
        ...(input.preferredMetaphors ?? []),
        ...decomposed.expansionTerms,
      ],
      direction,
    );
    if (match) {
      const hits = this.store.ftsSearch(match, THRESHOLDS.ftsCandidates);
      const best = hits[0]?.score ?? 0;
      for (const hit of hits) {
        upsert(
          this.store.getSymbol(hit.name),
          { lexical: best > 0 ? hit.score / best : 0 },
          "text match",
        );
      }
    }

    // 3. Semantic embedding retrieval.
    if (this.embedder) {
      const semanticMatrix = this.store.matrix("embedding_semantic");
      if (semanticMatrix) {
        try {
          const queryVector = await this.embedder.embedQuery(input.query);
          for (const hit of topKSimilar(
            semanticMatrix,
            queryVector,
            THRESHOLDS.embeddingCandidates,
          )) {
            upsert(
              this.store.getSymbol(hit.name),
              { semantic: Math.max(0, hit.score) },
              "semantic similarity",
            );
          }
          const visualDescMatrix = this.store.matrix("embedding_visualdesc");
          if (visualDescMatrix) {
            for (const hit of topKSimilar(visualDescMatrix, queryVector, 30)) {
              upsert(
                this.store.getSymbol(hit.name),
                { visualDesc: Math.max(0, hit.score) },
                "visual description match",
              );
            }
          }
        } catch {
          // Embedder unavailable (model still warming or missing) — lexical-only.
        }
      }
    }

    // 4. Curated UI-convention priors (single tokens + adjacent-token bigrams).
    const conventionKeys = new Set<string>();
    if (primaryAction) conventionKeys.add(primaryAction);
    const queryTokenList = tokenize(input.query);
    for (const token of queryTokenList) {
      const canonical = canonicalAction(token);
      if (canonical) conventionKeys.add(canonical);
      if (UI_CONVENTIONS[token]) conventionKeys.add(token);
    }
    for (let i = 0; i < queryTokenList.length - 1; i++) {
      for (const key of bigramKeys(
        queryTokenList[i] as string,
        queryTokenList[i + 1] as string,
      )) {
        if (UI_CONVENTIONS[key]) conventionKeys.add(key);
      }
    }
    for (const key of conventionKeys) {
      for (const entry of UI_CONVENTIONS[key] ?? []) {
        upsert(
          this.store.getSymbol(entry.symbol),
          { curatedPrior: entry.prior },
          `standard ${key} icon`,
        );
      }
    }
    // preferredMetaphors boost curated prior (capped at 1.0 in scoring).
    for (const metaphor of input.preferredMetaphors ?? []) {
      const asName = metaphor.toLowerCase().replaceAll(/\s+/g, ".");
      const record =
        this.store.getSymbol(asName) ??
        this.store.getSymbol(this.store.resolveAlias(asName) ?? "");
      if (record) {
        const existing = candidates.get(record.name);
        upsert(
          record,
          { curatedPrior: Math.min(1, (existing?.curatedPrior ?? 0) + 0.5) },
          "preferred metaphor",
        );
      }
    }

    const totalCandidates = candidates.size;

    // ---- Hard filters.
    const queryTokens = new Set(
      tokenize(
        [input.query, input.object ?? "", input.primaryAction ?? ""].join(" "),
      ),
    );
    const filtered = [...candidates.values()].filter(({ record }) => {
      if (
        input.platforms &&
        !meetsAvailability(record.availability, input.platforms)
      ) {
        return false;
      }
      if (record.restricted && !input.includeRestricted) {
        const subjectTokens = tokenize(record.restrictionSubject ?? "");
        const nameTokens = record.name.split(".");
        const mentioned =
          subjectTokens.some((t) => queryTokens.has(t)) ||
          nameTokens.some((t) => queryTokens.has(t));
        if (!mentioned) return false;
      }
      return true;
    });

    // ---- Scoring.
    const scored = filtered.map((candidate) => {
      const { record } = candidate;
      const annotations = record.annotations;
      const likelyActions = new Set(
        [
          ...(annotations?.semantic?.value.likelyActions ?? []),
          ...(annotations?.reconciled?.value.minedAliases ?? []),
        ].map((a) => a.toLowerCase()),
      );
      const nameTokenSet = new Set(record.name.split("."));
      const resultWarnings: Warning[] = [];
      const penaltiesApplied: Record<string, number> = {};

      // actionMatch: canonical action in annotations (1.0), metaphor tokens
      // in name (0.6). A strong curated-convention hit is itself evidence the
      // symbol expresses the queried action — floor at 0.7.
      let actionMatch = candidate.curatedPrior >= 0.9 ? 0.7 : 0;
      if (primaryAction) {
        if (
          likelyActions.has(primaryAction) ||
          nameTokenSet.has(primaryAction)
        ) {
          actionMatch = 1.0;
        } else if (actionMatch < 0.6) {
          const stemmedName = new Set(
            [...nameTokenSet].map((t) => lightStem(t)),
          );
          if (
            action?.metaphors.some((m) =>
              m.split(" ").every((t) => stemmedName.has(lightStem(t))),
            )
          ) {
            actionMatch = 0.6;
          }
        }
      }

      // objectMatch: object vocabulary overlaps name tokens or annotated objects.
      let objectMatch = 0;
      if (objectVocab.size > 0) {
        const annotationObjects = new Set(
          [
            ...(annotations?.literal?.value.primaryObjects ?? []),
            ...(annotations?.semantic?.value.likelyObjects ?? []),
          ].flatMap(tokenize),
        );
        const hits = [...objectVocab].filter(
          (t) => nameTokenSet.has(t) || annotationObjects.has(t),
        );
        objectMatch = hits.length > 0 ? Math.min(1, 0.5 + 0.25 * hits.length) : 0;
      }

      // Penalties.
      if (direction) {
        const nameDirections = record.name
          .split(".")
          .filter((t) => NAME_DIRECTIONS.has(t));
        const annotationDirections =
          annotations?.literal?.value.directions ?? [];
        const allDirections = [...nameDirections, ...annotationDirections];
        if (allDirections.length > 0 && !allDirections.includes(direction)) {
          penaltiesApplied["directionConflict"] = PENALTIES.directionConflict;
        }
      }
      if (antonyms.size > 0) {
        const conflict = [...antonyms].some(
          (a) => nameTokenSet.has(a) || likelyActions.has(a),
        );
        if (conflict) {
          penaltiesApplied["actionConflict"] = PENALTIES.actionConflict;
        }
      }
      if (excludedTerms.length > 0) {
        const annotationObjects = new Set(
          (annotations?.literal?.value.primaryObjects ?? []).flatMap(tokenize),
        );
        const hit = excludedTerms.some(
          (t) => nameTokenSet.has(t) || annotationObjects.has(t),
        );
        if (hit) {
          penaltiesApplied["excludedMetaphor"] = PENALTIES.excludedMetaphor;
          resultWarnings.push({
            type: "excluded-metaphor",
            message: `\`${record.name}\` contains an excluded metaphor but remained a strong match.`,
          });
        }
      }
      if (record.restricted) {
        penaltiesApplied["restricted"] = input.includeRestricted
          ? 0
          : PENALTIES.restricted * 0.5; // waived candidates already mention the product
        resultWarnings.push({
          type: "restricted",
          message:
            `\`${record.name}\` is usage-restricted by Apple` +
            (record.restrictionSubject
              ? ` — only use it to refer to ${record.restrictionSubject}.`
              : "."),
        });
      }
      if (!input.platforms) {
        const iOS = record.availability.iOS;
        if (iOS && compareOsVersions(iOS, "26.0") >= 0) {
          penaltiesApplied["recencyRisk"] = PENALTIES.recencyRisk;
        }
      }
      if (hasAnnotations && record.unannotated) {
        penaltiesApplied["unannotated"] = PENALTIES.unannotated;
      }
      const ambiguities = annotations?.semantic?.value.ambiguities ?? [];
      if (ambiguities.length > 0) {
        const overlap = ambiguities.some((a) =>
          tokenize(a).some((t) => queryTokens.has(t)),
        );
        if (overlap) {
          penaltiesApplied["ambiguityRisk"] = PENALTIES.ambiguityRisk;
          resultWarnings.push({
            type: "ambiguity",
            message: `\`${record.name}\` can be misread: ${ambiguities[0]}`,
          });
        }
      }

      const penaltyTotal = Object.values(penaltiesApplied).reduce(
        (a, b) => a + b,
        0,
      );
      const score =
        WEIGHTS.lexical * candidate.lexical +
        WEIGHTS.semantic * candidate.semantic +
        WEIGHTS.actionMatch * actionMatch +
        WEIGHTS.objectMatch * objectMatch +
        WEIGHTS.curatedPrior * Math.min(1, candidate.curatedPrior) +
        WEIGHTS.visualDesc * candidate.visualDesc -
        penaltyTotal;

      const breakdown: ScoreBreakdown = {
        lexical: candidate.lexical,
        semantic: candidate.semantic,
        actionMatch,
        objectMatch,
        curatedPrior: Math.min(1, candidate.curatedPrior),
        visualDesc: candidate.visualDesc,
        penalties: penaltiesApplied,
      };
      return { ...candidate, score, resultWarnings, breakdown };
    });

    // ---- Family dedup: the family's score is its best member's score, but
    // the plain canonical representative fronts the result (semantics before
    // style variants) — unless the winning member was an exact-name hit, the
    // query itself implies that variant, or the representative fails the
    // caller's platform filter.
    const MODIFIER_INTENTS: Record<string, string[]> = {
      slash: ["slash", "slashed", "line", "through", "crossed", "strikethrough", "off", "disabled", "muted", "no"],
      fill: ["fill", "filled", "solid", "selected"],
      badge: ["badge", "badged", "notification", "dot"],
    };
    const stateIntents: Record<string, string> = {
      off: "slash",
      disabled: "slash",
      muted: "slash",
      selected: "fill",
      new: "badge",
    };
    const impliedModifiers = new Set<string>();
    for (const [modifier, cues] of Object.entries(MODIFIER_INTENTS)) {
      if (cues.some((cue) => queryTokens.has(cue))) impliedModifiers.add(modifier);
    }
    if (input.state && stateIntents[input.state]) {
      impliedModifiers.add(stateIntents[input.state] as string);
    }

    const byFamily = new Map<string, (typeof scored)[number]>();
    for (const candidate of scored) {
      const key = candidate.record.baseName;
      const current = byFamily.get(key);
      if (!current || candidate.score > current.score) {
        byFamily.set(key, candidate);
      }
    }
    for (const [key, winner] of byFamily) {
      if (winner.reasons.includes("exact name match")) continue;
      const winnerModifiers = winner.record.modifiers.map((m) => m.split(".")[0] as string);
      if (winnerModifiers.some((m) => impliedModifiers.has(m))) continue;
      const family = this.store.family(key);
      const representativeName = family?.members[0];
      if (!representativeName || representativeName === winner.record.name) {
        continue;
      }
      const representative = this.store.getSymbol(representativeName);
      if (!representative || representative.deprecated) continue;
      if (
        input.platforms &&
        !meetsAvailability(representative.availability, input.platforms)
      ) {
        continue;
      }
      byFamily.set(key, { ...winner, record: representative });
    }

    const results: SearchResult[] = [...byFamily.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record, score, reasons, resultWarnings, breakdown }) => {
        const family = this.store.family(record.baseName);
        const variants: VariantInfo[] =
          includeVariants && family
            ? family.members
                .filter((m) => m !== record.name)
                .map((m) => ({
                  name: m,
                  modifiers: this.store.getSymbol(m)?.modifiers ?? [],
                }))
            : [];
        const annotations = record.annotations;
        const description =
          annotations?.reconciled?.value.finalDescription ??
          annotations?.literal?.value.literalDescription;
        const likelyActions = annotations?.semantic?.value.likelyActions;
        return {
          name: record.name,
          score: Number(score.toFixed(4)),
          reason: [...new Set(reasons)].join("; "),
          family: { baseName: record.baseName, variants },
          availability: record.availability,
          categories: record.categories,
          restricted: record.restricted,
          ...(record.restrictionSubject !== undefined && {
            restrictionSubject: record.restrictionSubject,
          }),
          deprecated: record.deprecated,
          ...(record.renamedTo !== undefined && { renamedTo: record.renamedTo }),
          ...(record.unannotated && hasAnnotations && { unannotated: true }),
          ...(description !== undefined && { description }),
          ...(likelyActions !== undefined && { likelyActions }),
          warnings: resultWarnings,
          ...(explain && { breakdown }),
        };
      });

    // ---- Response-level warnings.
    if (results.length === 0) {
      warnings.push({
        type: "low-confidence",
        message:
          "No matches. Try describing the ACTION the icon performs (e.g. 'delete', 'share') or the objects it should depict.",
      });
    } else {
      const top = results[0] as SearchResult;
      const second = results[1];
      if (second && top.score - second.score < THRESHOLDS.closeCall) {
        warnings.push({
          type: "close-call",
          message: `Close call between \`${top.name}\` and \`${second.name}\` — compare them with compare_sf_symbols before deciding.`,
        });
      }
    }

    return {
      results,
      warnings,
      interpretation: {
        ...(primaryAction !== undefined && { primaryAction }),
        objects: objectWords,
        ...(direction !== undefined && { direction }),
        excludedTerms,
      },
      catalogVersion: this.store.meta("sfSymbolsVersion") ?? "unknown",
      totalCandidates,
    };
  }

  /** Resolve a name that may be an alias or deprecated to its canonical record. */
  lookup(name: string): {
    record: SymbolRecord | null;
    canonicalName?: string;
  } {
    const direct = this.store.getSymbol(name);
    if (direct && !direct.deprecated) return { record: direct };
    const alias = this.store.resolveAlias(name);
    if (alias) {
      return { record: this.store.getSymbol(alias), canonicalName: alias };
    }
    return { record: direct };
  }
}
