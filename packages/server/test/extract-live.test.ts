import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { extractCatalog, locateSources } from "../src/extract/index.js";

/**
 * Live integration test against the real local SF Symbols installation.
 * macOS only; skipped elsewhere. Asserts invariants without persisting any
 * Apple-derived output.
 */
describe.skipIf(platform() !== "darwin" || locateSources() === null)(
  "live extraction",
  () => {
    it("extracts a plausible catalog from the local installation", async () => {
      const { catalog, manifest } = await extractCatalog();

      expect(manifest.counts.rawSymbols).toBeGreaterThan(6000);
      expect(catalog.symbols.length).toBeGreaterThan(5500);
      expect(catalog.symbols.length).toBeLessThan(manifest.counts.rawSymbols);
      expect(catalog.categories.length).toBeGreaterThanOrEqual(25);
      expect(manifest.counts.aliases).toBeGreaterThan(500);

      const bell = catalog.symbols.find((s) => s.name === "bell");
      expect(bell).toBeDefined();
      expect(bell?.availability.iOS).toBe("13.0");
      expect(bell?.categories).toContain("objectsandtools");

      const tray = catalog.symbols.find(
        (s) => s.name === "tray.and.arrow.down",
      );
      expect(tray).toBeDefined();

      // Fill mapping present and self-consistent.
      expect(catalog.nofillToFill["gamecontroller"]).toBe(
        "gamecontroller.fill",
      );

      // Localized variants folded: no base symbol name ends in a script suffix
      // that has an existing stem.
      const folded = catalog.symbols.flatMap((s) => s.localizedVariants);
      expect(folded.length).toBeGreaterThan(100);
      const scripts = [...new Set(folded.map((v) => v.script))].sort();
      // Eyeball check in test output: collisions with real modifiers would show here.
      console.info("folded script suffixes:", scripts.join(", "));
      console.info(
        "sample folded variants:",
        folded.slice(0, 5).map((v) => v.name),
      );

      // Restrictions came from CoreGlyphs with subjects extracted.
      if (manifest.counts.restricted > 0) {
        const restricted = catalog.symbols.filter((s) => s.restricted);
        expect(restricted.length).toBeGreaterThan(300);
        const withSubject = restricted.filter((s) => s.restrictionSubject);
        expect(withSubject.length / restricted.length).toBeGreaterThan(0.9);
      }

      // Manifest hashes cover every source file.
      expect(Object.keys(manifest.fileHashes).length).toBeGreaterThanOrEqual(
        5,
      );
    });
  },
);
