import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogStore } from "../src/store/catalog-store.js";
import { canonicalAction, decompose, UI_CONVENTIONS } from "../src/search/decompose.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const DB_PATH = join(ROOT, "generated-local", "db", "catalog-local.db");

describe("decomposer", () => {
  it("canonicalizes verbs, synonyms, and two-word phrases", () => {
    expect(canonicalAction("download")).toBe("download");
    expect(canonicalAction("fetch")).toBe("download");
    expect(canonicalAction("erase")).toBe("delete");
    expect(canonicalAction("sign out")).toBe("logout");
    expect(canonicalAction("frobnicate")).toBeNull();
  });

  it("decomposes a plain query", () => {
    const d = decompose("download the invoice");
    expect(d.primaryAction).toBe("download");
    expect(d.objects).toContain("invoice");
  });

  it("skips generic display verbs as actions", () => {
    expect(decompose("show an error occurred").primaryAction).not.toBe("show");
    expect(decompose("open the chat conversation").primaryAction).not.toBe("open");
  });

  it("captures negations", () => {
    const d = decompose("download without cloud");
    expect(d.negatedTerms).toContain("cloud");
  });
});

/**
 * Never-fabricate invariant: every symbol referenced by the curated
 * conventions must exist in the catalog (as a name or resolvable alias).
 */
describe.skipIf(!existsSync(DB_PATH))("lexicon integrity", () => {
  it("all convention symbols exist in the catalog", () => {
    const store = new CatalogStore(DB_PATH);
    const missing: string[] = [];
    for (const [key, entries] of Object.entries(UI_CONVENTIONS)) {
      for (const entry of entries) {
        const exists =
          store.getSymbol(entry.symbol) !== null ||
          store.resolveAlias(entry.symbol) !== null;
        if (!exists) missing.push(`${key} -> ${entry.symbol}`);
      }
    }
    store.close();
    expect(missing).toEqual([]);
  });
});
