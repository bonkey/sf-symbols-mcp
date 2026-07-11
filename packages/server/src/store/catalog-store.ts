import { DatabaseSync } from "node:sqlite";
import type {
  Availability,
  SymbolAnnotations,
} from "@sfsmcp/schema";
import { FTS_BM25_WEIGHTS } from "@sfsmcp/schema";

export interface SymbolRecord {
  name: string;
  baseName: string;
  modifiers: string[];
  categories: string[];
  availability: Availability;
  layersets: Record<string, Availability>;
  deprecated: boolean;
  renamedTo?: string;
  restricted: boolean;
  restrictionSubject?: string;
  restrictionText?: string;
  rtlFlippable: boolean;
  localizedVariants: { name: string; script: string }[];
  sortOrder?: number;
  appleKeywords?: string[];
  annotations?: SymbolAnnotations;
  unannotated: boolean;
  phash?: string;
}

export interface FamilyRecord {
  baseName: string;
  members: string[];
}

export interface FtsHit {
  name: string;
  /** bm25 score, negated so HIGHER is better. */
  score: number;
}

interface SymbolRow {
  name: string;
  base_name: string;
  modifiers_json: string;
  categories_json: string;
  availability_json: string;
  layersets_json: string;
  deprecated: number;
  renamed_to: string | null;
  restricted: number;
  restriction_subject: string | null;
  restriction_text: string | null;
  rtl_flippable: number;
  localized_variants_json: string;
  sort_order: number | null;
  apple_keywords_json: string | null;
  annotations_json: string | null;
  unannotated: number;
  phash: string | null;
}

function rowToRecord(row: SymbolRow): SymbolRecord {
  return {
    name: row.name,
    baseName: row.base_name,
    modifiers: JSON.parse(row.modifiers_json) as string[],
    categories: JSON.parse(row.categories_json) as string[],
    availability: JSON.parse(row.availability_json) as Availability,
    layersets: JSON.parse(row.layersets_json) as Record<string, Availability>,
    deprecated: row.deprecated === 1,
    ...(row.renamed_to !== null && { renamedTo: row.renamed_to }),
    restricted: row.restricted === 1,
    ...(row.restriction_subject !== null && {
      restrictionSubject: row.restriction_subject,
    }),
    ...(row.restriction_text !== null && {
      restrictionText: row.restriction_text,
    }),
    rtlFlippable: row.rtl_flippable === 1,
    localizedVariants: JSON.parse(row.localized_variants_json) as {
      name: string;
      script: string;
    }[],
    ...(row.sort_order !== null && { sortOrder: row.sort_order }),
    ...(row.apple_keywords_json !== null && {
      appleKeywords: JSON.parse(row.apple_keywords_json) as string[],
    }),
    ...(row.annotations_json !== null && {
      annotations: JSON.parse(row.annotations_json) as SymbolAnnotations,
    }),
    unannotated: row.unannotated === 1,
    ...(row.phash !== null && { phash: row.phash }),
  };
}

/** Read-only access to the prebuilt catalog database. */
export class CatalogStore {
  private readonly db: DatabaseSync;
  private aliasMap: Map<string, string> | undefined;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  meta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  getSymbol(name: string): SymbolRecord | null {
    const row = this.db
      .prepare("SELECT * FROM symbols WHERE name = ?")
      .get(name) as SymbolRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** All alias -> canonical mappings (lazily cached; ~1k rows). */
  aliases(): Map<string, string> {
    if (!this.aliasMap) {
      const rows = this.db
        .prepare("SELECT alias, canonical FROM aliases")
        .all() as { alias: string; canonical: string }[];
      this.aliasMap = new Map(rows.map((r) => [r.alias, r.canonical]));
    }
    return this.aliasMap;
  }

  /** Resolve an old/semantic alias (or a deprecated symbol) to its canonical name. */
  resolveAlias(name: string): string | null {
    return this.aliases().get(name) ?? null;
  }

  family(baseName: string): FamilyRecord | null {
    const row = this.db
      .prepare("SELECT base_name, members_json FROM families WHERE base_name = ?")
      .get(baseName) as
      | { base_name: string; members_json: string }
      | undefined;
    if (!row) return null;
    return {
      baseName: row.base_name,
      members: JSON.parse(row.members_json) as string[],
    };
  }

  /**
   * BM25 full-text search over the weighted FTS columns.
   * The query must be a valid FTS5 MATCH expression (callers build it from
   * sanitized tokens only).
   */
  ftsSearch(match: string, limit: number): FtsHit[] {
    const weights = FTS_BM25_WEIGHTS.join(", ");
    const rows = this.db
      .prepare(
        `SELECT symbol_name AS name, -bm25(symbol_fts, ${weights}) AS score
         FROM symbol_fts WHERE symbol_fts MATCH ? ORDER BY score DESC LIMIT ?`,
      )
      .all(match, limit) as { name: string; score: number }[];
    return rows;
  }

  curatedMappings(): Map<string, { symbol: string; prior: number }[]> {
    const rows = this.db
      .prepare("SELECT ui_action, symbols_json FROM curated_mappings")
      .all() as { ui_action: string; symbols_json: string }[];
    return new Map(
      rows.map((r) => [
        r.ui_action,
        JSON.parse(r.symbols_json) as { symbol: string; prior: number }[],
      ]),
    );
  }

  symbolCount(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM symbols")
      .get() as { n: number };
    return row.n;
  }
}
