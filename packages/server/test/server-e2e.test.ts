import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end test over real stdio against a locally built catalog DB.
 * Skipped when no local DB has been built (e.g. fresh CI checkout).
 */
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const DB_PATH = join(ROOT, "generated-local", "db", "catalog-local.db");

describe.skipIf(!existsSync(DB_PATH))("MCP server e2e (stdio)", () => {
  let client: Client;
  let connectMs: number;

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as { type: string; text: string }[];
    return JSON.parse(content[0]?.text ?? "{}");
  };

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: join(ROOT, "node_modules", ".bin", "tsx"),
      args: [join(ROOT, "packages", "server", "src", "index.ts")],
      env: { ...process.env, SF_SYMBOLS_MCP_DB: DB_PATH },
    });
    client = new Client({ name: "e2e", version: "0" });
    const t0 = Date.now();
    await client.connect(transport);
    connectMs = Date.now() - t0;
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it("lists the tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("search_sf_symbols");
    expect(names).toContain("get_sf_symbol_info");
    expect(names).toContain("resolve_sf_symbol_variant");
  });

  it("finds download symbols for 'download the invoice'", async () => {
    const res = await call("search_sf_symbols", {
      query: "download the invoice",
      primaryAction: "download",
      object: "document",
      limit: 8,
    });
    const names = res.results.map((r: { name: string }) => r.name);
    expect(
      names.some((n: string) =>
        [
          "arrow.down.circle",
          "arrow.down.doc",
          "square.and.arrow.down",
          "tray.and.arrow.down",
          "arrow.down",
        ].some((expected) => n.startsWith(expected)),
      ),
    ).toBe(true);
  });

  it("finds archivebox for 'archive this message'", async () => {
    const res = await call("search_sf_symbols", {
      query: "archive this message",
      primaryAction: "archive",
      limit: 8,
    });
    const names = res.results.map((r: { name: string }) => r.name);
    expect(names.some((n: string) => n.startsWith("archivebox"))).toBe(true);
  });

  it("filters by minimum OS version", async () => {
    const res = await call("search_sf_symbols", {
      query: "arrow trianglehead clockwise rotate",
      platforms: { iOS: "15.0" },
      limit: 10,
    });
    for (const r of res.results as {
      availability: { iOS?: string };
      name: string;
    }[]) {
      expect(r.availability.iOS, `${r.name} availability`).toBeDefined();
      expect(Number.parseFloat(r.availability.iOS as string)).toBeLessThanOrEqual(15);
    }
  });

  it("hides restricted symbols unless the query names the product", async () => {
    const generic = await call("search_sf_symbols", {
      query: "find lost tracking tag device",
      limit: 10,
    });
    const genericNames = generic.results.map((r: { name: string }) => r.name);
    expect(genericNames).not.toContain("airtag");

    const explicit = await call("search_sf_symbols", {
      query: "airtag",
      limit: 5,
    });
    const explicitNames = explicit.results.map((r: { name: string }) => r.name);
    expect(explicitNames).toContain("airtag");
    const airtag = explicit.results.find(
      (r: { name: string }) => r.name === "airtag",
    );
    expect(airtag.restricted).toBe(true);
    expect(
      airtag.warnings.some((w: { type: string }) => w.type === "restricted"),
    ).toBe(true);
  });

  it("returns full symbol info and resolves semantic aliases", async () => {
    const info = await call("get_sf_symbol_info", { name: "trash" });
    expect(info.name).toBe("trash");
    expect(info.family.members.length).toBeGreaterThan(2);

    const viaAlias = await call("get_sf_symbol_info", { name: "compose" });
    expect(viaAlias.name).toBe("square.and.pencil");
  });

  it("resolves variants by state, semantics, and conventions", async () => {
    const badge = await call("resolve_sf_symbol_variant", {
      base: "bell",
      semantics: "notification",
    });
    expect(badge.resolved).toBe("bell.badge");
    expect(badge.exists).toBe(true);

    const slashFill = await call("resolve_sf_symbol_variant", {
      base: "bell",
      state: { slashed: true, filled: true },
    });
    expect(slashFill.resolved).toBe("bell.slash.fill");

    const tabBar = await call("resolve_sf_symbol_variant", {
      base: "gearshape",
      uiContext: "tabBar",
      selected: true,
      platform: "iOS",
    });
    expect(tabBar.resolved).toBe("gearshape.fill");

    const impossible = await call("resolve_sf_symbol_variant", {
      base: "tray.and.arrow.down",
      state: { badge: "plus" },
    });
    expect(impossible.exists).toBe(false);
    expect(impossible.resolved).toMatch(/^tray/);
    expect(impossible.nearestAlternatives.length).toBeGreaterThan(0);
  });

  it("compares candidate symbols", async () => {
    const res = await call("compare_sf_symbols", {
      names: ["trash", "xmark.bin", "minus.circle"],
    });
    expect(res.symbols.map((s: { name: string }) => s.name)).toEqual([
      "trash",
      "xmark.bin",
      "minus.circle",
    ]);
    expect(res.differences.length).toBe(3);
  });

  it("finds visually similar symbols", async () => {
    const res = await call("find_visually_similar_symbols", {
      name: "bell",
      limit: 5,
    });
    expect(res.results.length).toBe(5);
    const names = res.results.map((r: { name: string }) => r.name);
    // Same-family members are excluded by default.
    expect(names).not.toContain("bell.fill");
    expect(res.results[0].similarity).toBeGreaterThan(0.5);
  });

  it("reports local catalog status without rebuilding (dryRun)", async () => {
    const res = await call("update_local_catalog", { dryRun: true });
    expect([
      "dry-run",
      "up-to-date",
      "unsupported-platform",
      "source-not-found",
    ]).toContain(res.status);
    expect(res.shippedVersion).toBeDefined();
  });

  it("connects fast enough", () => {
    expect(connectMs).toBeLessThan(3_000); // tsx startup dominates in dev; the bundled build is far faster
  });
});
