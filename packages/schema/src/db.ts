/**
 * SQLite DDL for catalog.db (shipped, read-only at runtime) and the user
 * overlay DB (writable, lives in the user data dir).
 *
 * Embeddings are stored as little-endian Float32 BLOBs, L2-normalized at
 * build time so cosine similarity is a plain dot product.
 */

export const SCHEMA_VERSION = 1;

export const CATALOG_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  name              TEXT PRIMARY KEY,
  base_name         TEXT NOT NULL,
  modifiers_json    TEXT NOT NULL DEFAULT '[]',
  categories_json   TEXT NOT NULL DEFAULT '[]',
  availability_json TEXT NOT NULL DEFAULT '{}',
  layersets_json    TEXT NOT NULL DEFAULT '{}',
  deprecated        INTEGER NOT NULL DEFAULT 0,
  renamed_to        TEXT,
  restricted        INTEGER NOT NULL DEFAULT 0,
  restriction_subject TEXT,
  restriction_text  TEXT,              -- Apple-authored; NULL in published packages (overlay only)
  rtl_flippable     INTEGER NOT NULL DEFAULT 0,
  localized_variants_json TEXT NOT NULL DEFAULT '[]',
  sort_order        INTEGER,
  apple_keywords_json TEXT,            -- Apple-authored; NULL in published packages (overlay only)
  annotations_json  TEXT,              -- SymbolAnnotations (independently authored)
  unannotated       INTEGER NOT NULL DEFAULT 0,
  phash             TEXT,
  embedding_semantic BLOB,             -- Float32[dims], L2-normalized
  embedding_visualdesc BLOB,           -- Float32[dims], L2-normalized
  embedding_visual  BLOB               -- Float32[dims] CLIP image vector, L2-normalized
);
CREATE INDEX IF NOT EXISTS idx_symbols_base ON symbols(base_name);

CREATE TABLE IF NOT EXISTS families (
  base_name       TEXT PRIMARY KEY,
  members_json    TEXT NOT NULL,
  analysis_json   TEXT               -- FamilyAnalysis
);

CREATE TABLE IF NOT EXISTS aliases (
  alias     TEXT NOT NULL,
  canonical TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (alias, canonical)
);

CREATE TABLE IF NOT EXISTS curated_mappings (
  ui_action    TEXT PRIMARY KEY,
  symbols_json TEXT NOT NULL          -- [{symbol, prior}]
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
  name_tokens,
  keywords,
  objects,
  actions,
  description,
  contexts,
  symbol_name UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`;

/** BM25 column weights matching symbol_fts column order (name, keywords, objects, actions, description, contexts, symbol_name). */
export const FTS_BM25_WEIGHTS = [10.0, 6.0, 4.0, 4.0, 2.0, 1.0, 0.0] as const;

export const OVERLAY_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS overlay_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Locally extracted Apple-authored data merged over the shipped catalog.
CREATE TABLE IF NOT EXISTS local_symbols (
  name              TEXT PRIMARY KEY,
  availability_json TEXT,
  categories_json   TEXT,
  layersets_json    TEXT,
  restricted        INTEGER,
  restriction_text  TEXT,
  apple_keywords_json TEXT,
  is_new            INTEGER NOT NULL DEFAULT 0   -- not present in the shipped catalog
);

CREATE TABLE IF NOT EXISTS local_aliases (
  alias     TEXT NOT NULL,
  canonical TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (alias, canonical)
);

-- FTS over locally added symbols/keywords (same column layout as symbol_fts).
CREATE VIRTUAL TABLE IF NOT EXISTS local_fts USING fts5(
  name_tokens,
  keywords,
  objects,
  actions,
  description,
  contexts,
  symbol_name UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`;
