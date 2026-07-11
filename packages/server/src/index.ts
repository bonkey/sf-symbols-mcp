#!/usr/bin/env node
/** sf-symbols-mcp — MCP server over stdio. */
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogStore } from "./store/catalog-store.js";
import { TransformersEmbedder } from "./embed/embedder.js";
import { registerTools } from "./tools/register.js";
import { preferredDbPath } from "./update/local-update.js";

const [major, minor] = process.versions.node.split(".").map(Number);
if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 13)) {
  console.error(
    `sf-symbols-mcp needs Node >= 22.13 (found ${process.versions.node}). ` +
      "It uses the built-in node:sqlite module.",
  );
  process.exit(1);
}

async function resolveDbPath(): Promise<string> {
  const fromEnv = process.env["SF_SYMBOLS_MCP_DB"];
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      console.error(`SF_SYMBOLS_MCP_DB points to a missing file: ${fromEnv}`);
      process.exit(1);
    }
    return fromEnv;
  }
  try {
    const data = await import("sf-symbols-mcp-data");
    if (existsSync(data.catalogDbPath)) return data.catalogDbPath;
    console.error(
      `sf-symbols-mcp-data is installed but ${data.catalogDbPath} is missing.`,
    );
  } catch {
    console.error(
      "No catalog database found. Install sf-symbols-mcp-data or set SF_SYMBOLS_MCP_DB.",
    );
  }
  process.exit(1);
}

async function resolveModelDir(): Promise<string | undefined> {
  const fromEnv = process.env["SF_SYMBOLS_MCP_MODEL_DIR"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const data = await import("sf-symbols-mcp-data");
    if (existsSync(data.modelDir)) return data.modelDir;
  } catch {
    // data package absent — transformers.js falls back to its cache.
  }
  return undefined;
}

const shippedDbPath = await resolveDbPath();
// A locally rebuilt catalog (update_local_catalog) wins when it is newer.
const dbPath = process.env["SF_SYMBOLS_MCP_DB"]
  ? shippedDbPath
  : (preferredDbPath(shippedDbPath) ?? shippedDbPath);
const store = new CatalogStore(dbPath);
const embedder = new TransformersEmbedder(await resolveModelDir());
// Warm the embedding model in the background; early queries run lexical-only.
void embedder.embedQuery("warmup").catch(() => {});

const server = new McpServer({ name: "sf-symbols-mcp", version: "0.1.0" });
registerTools(server, store, embedder, shippedDbPath);

await server.connect(new StdioServerTransport());
console.error(
  `sf-symbols-mcp ready — catalog ${store.meta("sfSymbolsVersion")} ` +
    `(${store.symbolCount()} symbols, ${store.annotatedCount()} annotated, ` +
    `profile ${store.meta("profile")})`,
);
