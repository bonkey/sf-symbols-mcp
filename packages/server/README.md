# sf-symbols-mcp

An MCP server that helps AI agents pick the **right SF Symbol** for a UI
function — "download the invoice", "archive this message", "show account
settings" — without hallucinating symbol names.

Every result is a **verified catalog entry**, found through layered retrieval:
query decomposition → lexical search (BM25/FTS5) → local semantic embeddings →
curated UI-convention priors → vision-derived glyph annotations → explainable
ranking with availability and restriction filtering.

**No API keys. No network at query time. No native build steps.** The prebuilt
catalog and a small local embedding model ship with the package; queries run
in ~100 ms on the built-in `node:sqlite` plus a 34 MB ONNX model.

## Quick start

```jsonc
// Claude Code / Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "sf-symbols": {
      "command": "npx",
      "args": ["-y", "sf-symbols-mcp"]
    }
  }
}
```

Requires Node ≥ 22.13 (for the built-in SQLite module).

## Tools

| Tool | Purpose |
|---|---|
| `search_sf_symbols` | Find symbols for a natural-language UI function. Optional structured fields (`primaryAction`, `object`, `direction`, `state`, `excludedMetaphors`, `platforms`, …) let the calling LLM decompose the query for sharply better ranking. |
| `get_sf_symbol_info` | Full metadata: availability, categories, family and variants, restriction status, semantic/visual annotations with provenance. |
| `compare_sf_symbols` | Structured diff of 2–6 candidates: semantics, pairwise visual similarity, availability deltas, when-to-use-which guidance. |
| `resolve_sf_symbol_variant` | Pick fill/slash/badge/enclosure variants by UI state and platform conventions (selected tab-bar → `.fill`, off → `.slash`, watchOS prefers fill, …). Never invents names. |
| `find_visually_similar_symbols` | Symbols that *look* alike (CLIP + perceptual hash): confusable glyphs, simpler alternatives. |
| `update_local_catalog` | Refresh from your locally installed SF Symbols app (macOS). New symbols become searchable immediately; annotations are preserved. |

Search results carry scores, one-line reasons, family variants, availability,
and typed warnings (restricted symbols, renamed inputs, close calls,
ambiguous glyphs). Pass `explain: true` for the full score breakdown.

## How it works

```
SF Symbols.app plists ──extract──▶ normalized catalog (names, availability,
        (macOS, plutil)             categories, aliases, restrictions)
renders (Swift, public APIs) ──▶ vision passes (literal → semantic → reconcile)
                                  + family analysis + deterministic features
                        ──build──▶ catalog.db (SQLite FTS5 + embedding BLOBs)
                                   + bge-small ONNX model, shipped via npm
```

- **Never fabricates**: retrieval happens only over catalog rows; curated
  mappings are CI-validated against the catalog.
- **Family-aware**: `bell/bell.fill/bell.badge/bell.slash` collapse to one
  result with variants attached; semantics are chosen before style.
- **Explainable**: weighted linear scoring (lexical, semantic, action/object
  match, curated prior, visual) with explicit penalties (direction conflicts,
  antonym actions, excluded metaphors, restrictions, deprecations).

## Maintainer pipeline (not needed by users)

All Apple-derived intermediates live in gitignored `generated-local/`.

```sh
pnpm extract        # read the local SF Symbols app metadata (macOS, plutil)
pnpm render         # deterministic 256px monochrome PNGs (Swift, public APIs)
pnpm features       # pHash, fill-score, symmetry, family grammar validation
pnpm annotate all --yes   # 3-pass vision annotation + family + consensus
pnpm embed          # bge-small text vectors + CLIP image vectors (local)
pnpm build-data --profile=default   # assemble catalog.db
pnpm eval           # golden-query ranking regression (81 queries)
pnpm pack-data      # stage packages/data for publishing
```

Annotation providers (pick one):

- **OpenRouter** (cheap, default): `export OPENROUTER_API_KEY=…` — runs on
  `google/gemini-2.5-flash` by default (`--model=<id>` to override), full
  catalog ≈ $3–8. Start with `pnpm annotate pass1 --pilot=50 --yes` and review
  `generated-local/annotations/<version>/pass1/` before the full run.
- **Anthropic Batches**: `export ANTHROPIC_API_KEY=…` — `claude-sonnet-5`
  with structured outputs, ≈ $130 per full catalog.

Every annotation stores provenance (model, prompt version, batch id) and
resumes via per-symbol checkpoints. Releasing: publish `packages/data`
(version minor tracks SF Symbols releases), then `packages/server`.

## Data profiles & licensing posture

| Profile | Contents |
|---|---|
| `default` (published) | Symbol names, availability, categories (facts), plus **independently authored** annotations, embeddings, curated lexicons. No Apple-authored keyword lists or restriction sentences. |
| `local` (your machine only) | Everything, including Apple's search keywords — created by `update_local_catalog` from your own SF Symbols installation. |
| `safe` (fallback) | Only independently authored data + bare names. |

## Apple IP notice

This project does **not** include, embed, or redistribute any Apple artwork,
fonts, symbol images, SVG templates, or Apple-authored metadata files. Symbol
*names* are used as factual identifiers for interoperability; all symbol
descriptions in the published data are independently authored. Some symbols
may be used only as-is to refer to the Apple technology they represent, and no
symbol may be used in app icons, logos, or any trademark-related way.

To use the local-extraction features you must install the
[SF Symbols app](https://developer.apple.com/sf-symbols/) yourself and accept
Apple's license. Locally rendered previews stay on your machine and must not
be redistributed. See [NOTICE](./NOTICE) for the full statement.

SF Symbols is a trademark of Apple Inc. This project is not affiliated with,
endorsed, or sponsored by Apple Inc.

## Development

```sh
pnpm install && pnpm test        # unit + e2e (e2e needs a local catalog build)
pnpm typecheck
pnpm --filter sf-symbols-mcp build   # bundle the server (single-file dist)
```

## License

MIT for all original code and independently authored data. See
[LICENSE](./LICENSE) and [NOTICE](./NOTICE).
