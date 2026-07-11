# sf-symbols-mcp

An MCP server that helps AI agents pick the **right SF Symbol** for a UI
function — "download the invoice", "archive this message", "show account
settings" — without hallucinating symbol names.

Every result is a **verified catalog entry**, found through layered retrieval:
query decomposition → lexical search (BM25) → semantic embeddings → curated
UI-convention priors → vision-derived glyph descriptions → explainable
ranking with availability and restriction filtering.

> **Status: under construction.** See the milestones in the repository issues.

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

No API keys, no network access at query time, no native build steps. Prebuilt
catalog data and a small local embedding model ship with the package.

## Tools

| Tool | Purpose |
|---|---|
| `search_sf_symbols` | Find symbols for a natural-language UI function |
| `get_sf_symbol_info` | Full metadata, annotations, family, provenance |
| `compare_sf_symbols` | Structured diff of candidate symbols |
| `resolve_sf_symbol_variant` | Pick fill/slash/badge/enclosure variant for a UI state |
| `find_visually_similar_symbols` | Visually similar or simpler alternatives |
| `update_local_catalog` | Refresh from your locally installed SF Symbols app (macOS) |

## Apple IP notice

This project does **not** include, embed, or redistribute any Apple artwork,
fonts, symbol images, SVG templates, or Apple-authored metadata files. Symbol
*names* are used as factual identifiers for interoperability; all symbol
descriptions in the published data are independently authored. Some symbols
may be used only as-is to refer to the Apple technology they represent, and no
symbol may be used in app icons, logos, or any trademark-related way.

To use the optional local-extraction features you must install the
[SF Symbols app](https://developer.apple.com/sf-symbols/) yourself and accept
Apple's license. See [NOTICE](./NOTICE) for the full statement.

SF Symbols is a trademark of Apple Inc. This project is not affiliated with,
endorsed, or sponsored by Apple Inc.

## License

MIT for all original code and independently authored data. See
[LICENSE](./LICENSE) and [NOTICE](./NOTICE).
