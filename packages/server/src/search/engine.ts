import type { CatalogStore, SymbolRecord } from "../store/catalog-store.js";
import { meetsAvailability } from "./availability.js";
import { buildMatch, exactNameCandidates, tokenize } from "./lexical.js";
import type { SearchInput } from "./schema.js";

export interface Warning {
  type:
    | "renamed"
    | "restricted"
    | "deprecated"
    | "availability"
    | "excluded-metaphor"
    | "low-confidence"
    | "close-call";
  message: string;
}

export interface VariantInfo {
  name: string;
  modifiers: string[];
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
  warnings: Warning[];
}

export interface SearchResponse {
  results: SearchResult[];
  warnings: Warning[];
  catalogVersion: string;
  totalCandidates: number;
}

interface Candidate {
  record: SymbolRecord;
  lexical: number;
  reasons: string[];
}

/**
 * Search engine. v0 = lexical retrieval (exact + alias + FTS/BM25),
 * availability and restriction filtering, family dedup. Embedding fusion,
 * curated priors, and the full scoring formula land with the annotation data.
 */
export class SearchEngine {
  constructor(private readonly store: CatalogStore) {}

  search(input: SearchInput): SearchResponse {
    const limit = input.limit ?? 8;
    const includeVariants = input.includeVariants ?? true;
    const warnings: Warning[] = [];
    const candidates = new Map<string, Candidate>();

    const addCandidate = (
      record: SymbolRecord | null,
      lexical: number,
      reason: string,
    ): void => {
      if (!record) return;
      // Deprecated names resolve to their canonical replacement.
      if (record.deprecated && record.renamedTo) {
        const canonical = this.store.getSymbol(record.renamedTo);
        if (canonical) {
          warnings.push({
            type: "renamed",
            message: `\`${record.name}\` was renamed to \`${record.renamedTo}\`; using the current name.`,
          });
          record = canonical;
        }
      }
      const existing = candidates.get(record.name);
      if (existing) {
        if (lexical > existing.lexical) existing.lexical = lexical;
        existing.reasons.push(reason);
      } else {
        candidates.set(record.name, {
          record,
          lexical,
          reasons: [reason],
        });
      }
    };

    // 1. Exact name / alias hits.
    for (const exact of exactNameCandidates(input.query)) {
      addCandidate(this.store.getSymbol(exact), 1.0, "exact name match");
      const viaAlias = this.store.resolveAlias(exact);
      if (viaAlias) {
        addCandidate(
          this.store.getSymbol(viaAlias),
          0.95,
          `alias of \`${exact}\``,
        );
      }
    }

    // 2. Full-text retrieval over query + decomposition fields.
    const texts = [
      input.query,
      input.primaryAction ?? "",
      input.object ?? "",
      input.destination ?? "",
      ...(input.preferredMetaphors ?? []),
    ];
    const { match } = buildMatch(texts, input.direction);
    if (match) {
      const hits = this.store.ftsSearch(match, 50);
      const best = hits[0]?.score ?? 0;
      for (const hit of hits) {
        addCandidate(
          this.store.getSymbol(hit.name),
          best > 0 ? hit.score / best : 0,
          "text match",
        );
      }
    }

    const totalCandidates = candidates.size;

    // 3. Hard filters.
    const queryTokens = new Set(
      tokenize(
        [input.query, input.object ?? "", input.primaryAction ?? ""].join(" "),
      ),
    );
    const excluded = new Set(
      (input.excludedMetaphors ?? []).flatMap(tokenize),
    );

    const filtered = [...candidates.values()].filter(({ record }) => {
      if (record.deprecated) return false;
      if (input.platforms && !meetsAvailability(record.availability, input.platforms)) {
        return false;
      }
      if (record.restricted && !input.includeRestricted) {
        // Waiver: the query explicitly names the restricted product.
        const subjectTokens = tokenize(record.restrictionSubject ?? "");
        const nameTokens = record.name.split(".");
        const mentioned =
          subjectTokens.some((t) => queryTokens.has(t)) ||
          nameTokens.some((t) => queryTokens.has(t));
        if (!mentioned) return false;
      }
      return true;
    });

    // 4. Score (v0: lexical + small penalties) and family grouping.
    const scored = filtered.map((candidate) => {
      let score = candidate.lexical;
      const resultWarnings: Warning[] = [];

      const nameTokens = new Set(candidate.record.name.split("."));
      const hasExcluded = [...excluded].some((t) => nameTokens.has(t));
      if (hasExcluded) {
        score -= 0.3;
        resultWarnings.push({
          type: "excluded-metaphor",
          message: `\`${candidate.record.name}\` contains an excluded metaphor but remained a strong match.`,
        });
      }
      if (candidate.record.restricted) {
        resultWarnings.push({
          type: "restricted",
          message:
            `\`${candidate.record.name}\` is usage-restricted by Apple` +
            (candidate.record.restrictionSubject
              ? ` — only use it to refer to ${candidate.record.restrictionSubject}.`
              : "."),
        });
      }
      return { ...candidate, score, resultWarnings };
    });

    // Family dedup: best member represents the family.
    const byFamily = new Map<string, (typeof scored)[number]>();
    for (const candidate of scored) {
      const key = candidate.record.baseName;
      const current = byFamily.get(key);
      if (!current || candidate.score > current.score) {
        byFamily.set(key, candidate);
      }
    }

    const results: SearchResult[] = [...byFamily.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record, score, reasons, resultWarnings }) => {
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
          ...(record.unannotated && { unannotated: true }),
          warnings: resultWarnings,
        };
      });

    if (results.length === 0) {
      warnings.push({
        type: "low-confidence",
        message:
          "No matches. Try describing the ACTION the icon performs (e.g. 'delete', 'share') or the objects it should depict.",
      });
    } else if (
      results.length >= 2 &&
      (results[0]?.score ?? 0) - (results[1]?.score ?? 0) < 0.07
    ) {
      warnings.push({
        type: "close-call",
        message: `Close call between \`${results[0]?.name}\` and \`${results[1]?.name}\` — compare them with compare_sf_symbols before deciding.`,
      });
    }

    return {
      results,
      warnings,
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
