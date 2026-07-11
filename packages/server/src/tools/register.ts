import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogStore } from "../store/catalog-store.js";
import type { QueryEmbedder } from "../embed/embedder.js";
import { SearchEngine } from "../search/engine.js";
import {
  getInfoInputShape,
  resolveVariantInputShape,
  searchInputShape,
  SearchInputSchema,
  ResolveVariantInputSchema,
} from "../search/schema.js";
import { resolveVariant } from "../search/variant.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerTools(
  server: McpServer,
  store: CatalogStore,
  embedder?: QueryEmbedder,
): void {
  const engine = new SearchEngine(store, embedder);

  server.registerTool(
    "search_sf_symbols",
    {
      title: "Search SF Symbols",
      description:
        "Find verified SF Symbol names for a natural-language UI function " +
        "(e.g. 'download the invoice', 'archive this message'). Returns ranked " +
        "symbol families with variants, availability, and warnings. Results " +
        "are always real catalog entries — never invented names. Fill in the " +
        "optional structured fields whenever the query implies them; they " +
        "substantially improve ranking.",
      inputSchema: searchInputShape,
    },
    async (args) => json(await engine.search(SearchInputSchema.parse(args))),
  );

  server.registerTool(
    "get_sf_symbol_info",
    {
      title: "Get SF Symbol info",
      description:
        "Full metadata for one SF Symbol: availability, categories, family " +
        "and variants, restriction status, aliases, and (when present) " +
        "semantic/visual annotations.",
      inputSchema: getInfoInputShape,
    },
    async ({ name }) => {
      const { record, canonicalName } = engine.lookup(name);
      if (!record) {
        return json({
          error: `\`${name}\` is not an SF Symbol name (checked names and aliases).`,
        });
      }
      const family = store.family(record.baseName);
      return json({
        ...(canonicalName !== undefined && {
          note: `\`${name}\` resolves to \`${canonicalName}\`.`,
        }),
        ...record,
        family: family
          ? {
              baseName: family.baseName,
              members: family.members.map((m) => ({
                name: m,
                modifiers: store.getSymbol(m)?.modifiers ?? [],
              })),
            }
          : null,
        catalogVersion: store.meta("sfSymbolsVersion"),
      });
    },
  );

  server.registerTool(
    "resolve_sf_symbol_variant",
    {
      title: "Resolve SF Symbol variant",
      description:
        "Given a symbol (any family member), pick the right variant for a UI " +
        "state or platform convention: fill/slash/badge/enclosure, selected " +
        "tab-bar items, watchOS/macOS conventions. Never invents names — " +
        "returns the closest existing variant with alternatives when the " +
        "requested combination doesn't exist.",
      inputSchema: resolveVariantInputShape,
    },
    async (args) =>
      json(resolveVariant(store, ResolveVariantInputSchema.parse(args))),
  );
}
