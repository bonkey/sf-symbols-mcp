import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogStore } from "../store/catalog-store.js";
import type { QueryEmbedder } from "../embed/embedder.js";
import { compareSymbols } from "../search/compare.js";
import { SearchEngine } from "../search/engine.js";
import {
  getInfoInputShape,
  resolveVariantInputShape,
  searchInputShape,
  SearchInputSchema,
  ResolveVariantInputSchema,
} from "../search/schema.js";
import { findVisuallySimilar } from "../search/similar.js";
import { resolveVariant } from "../search/variant.js";
import { performLocalUpdate } from "../update/local-update.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerTools(
  server: McpServer,
  store: CatalogStore,
  embedder?: QueryEmbedder,
  shippedDbPath?: string,
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

  server.registerTool(
    "compare_sf_symbols",
    {
      title: "Compare SF Symbols",
      description:
        "Structured comparison of 2-6 candidate symbols for one UI function: " +
        "per-symbol semantics, pairwise visual similarity and availability " +
        "deltas, and when-to-use-which guidance.",
      inputSchema: {
        names: z
          .array(z.string())
          .min(2)
          .max(6)
          .describe("The candidate symbol names to compare."),
      },
    },
    async ({ names }) => json(compareSymbols(store, names)),
  );

  server.registerTool(
    "find_visually_similar_symbols",
    {
      title: "Find visually similar symbols",
      description:
        "Symbols that LOOK like the given one (shape, not meaning): simpler " +
        "alternatives, confusable glyphs, same metaphor with different " +
        "modifiers. Same-family variants are excluded by default.",
      inputSchema: {
        name: z.string().min(1).describe("Anchor symbol name."),
        limit: z.number().int().min(1).max(30).optional(),
        method: z.enum(["embedding", "phash", "hybrid"]).optional(),
        excludeSameFamily: z.boolean().optional(),
      },
    },
    async ({ name, limit, method, excludeSameFamily }) =>
      json(
        findVisuallySimilar(store, name, {
          ...(limit !== undefined && { limit }),
          ...(method !== undefined && { method }),
          ...(excludeSameFamily !== undefined && { excludeSameFamily }),
        }),
      ),
  );

  server.registerTool(
    "update_local_catalog",
    {
      title: "Update local catalog",
      description:
        "Refresh the catalog from the locally installed SF Symbols app " +
        "(macOS only). New symbols become searchable immediately; existing " +
        "annotations and embeddings are preserved. Use dryRun to preview.",
      inputSchema: {
        dryRun: z.boolean().optional().describe("Report what would change without rebuilding."),
      },
    },
    async ({ dryRun }) => {
      if (!shippedDbPath) {
        return json({ status: "error", note: "No base catalog path available." });
      }
      return json(
        await performLocalUpdate(shippedDbPath, {
          ...(dryRun !== undefined && { dryRun }),
        }),
      );
    },
  );
}
