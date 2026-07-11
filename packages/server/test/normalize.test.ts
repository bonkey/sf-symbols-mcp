import { describe, expect, it } from "vitest";
import {
  normalizeCatalog,
  restrictionSubject,
  splitScriptVariant,
  type RawMetadata,
} from "../src/extract/normalize.js";

const SCRIPTS = new Map([
  ["ar", "Arabic"],
  ["hi", "Hindi"],
]);

/** Fully synthetic metadata — invented symbol names only. */
function syntheticRaw(overrides: Partial<RawMetadata> = {}): RawMetadata {
  return {
    source: "sf-symbols-app",
    version: { short: "9.9", build: "999" },
    nameAvailability: {
      symbols: {
        "testsymbol": "2019",
        "testsymbol.fill": "2019",
        "testsymbol.ar": "2022.1",
        "testglyph.badge": "2023",
        "orphan.hi": "2020",
      },
      year_to_release: {
        "2019": { iOS: "13.0", macOS: "10.15" },
        "2020": { iOS: "14.0", macOS: "11.0" },
        "2022.1": { iOS: "16.1", macOS: "13.0" },
        "2023": { iOS: "17.0", macOS: "14.0" },
      },
    },
    layersetAvailability: {
      symbols: { testsymbol: { hierarchical: "2023" } },
      year_to_release: { "2023": { iOS: "17.0", macOS: "14.0" } },
    },
    categories: [{ key: "testing", label: "Testing", icon: "testsymbol" }],
    symbolCategories: { testsymbol: ["testing"] },
    symbolSearch: { testsymbol: ["ring", "chime"] },
    nameAliases: { "oldsymbol.name": "testsymbol.fill" },
    legacyAliases: { ancientname: "testsymbol" },
    semanticToDescriptive: { ring: "testsymbol.fill" },
    restrictions: {
      "testglyph.badge":
        "This symbol may not be modified and may only be used to refer to Apple’s TestProduct.",
    },
    nofillToFill: { testsymbol: "testsymbol.fill" },
    symbolOrder: ["testsymbol", "testsymbol.fill"],
    legacyFlippable: ["testglyph.badge"],
    scriptExtensions: SCRIPTS,
    ...overrides,
  };
}

const AT = "2026-01-01T00:00:00.000Z";

describe("splitScriptVariant", () => {
  const names = new Set(["testsymbol", "testsymbol.ar", "orphan.hi"]);

  it("folds a script suffix when the stem exists", () => {
    expect(splitScriptVariant("testsymbol.ar", names, SCRIPTS)).toEqual({
      base: "testsymbol",
      script: "ar",
    });
  });

  it("keeps names whose stem does not exist", () => {
    expect(splitScriptVariant("orphan.hi", names, SCRIPTS)).toBeNull();
  });

  it("ignores non-script suffixes", () => {
    expect(
      splitScriptVariant("testsymbol.fill", new Set(["testsymbol"]), SCRIPTS),
    ).toBeNull();
  });
});

describe("restrictionSubject", () => {
  it("extracts the product after «refer to», dropping Apple’s possessive", () => {
    expect(
      restrictionSubject(
        "This symbol may not be modified and may only be used to refer to Apple’s AirTag.",
      ),
    ).toBe("AirTag");
  });

  it("handles subjects without the possessive", () => {
    expect(
      restrictionSubject(
        "This symbol may only be used to refer to the Example Service.",
      ),
    ).toBe("Example Service");
  });

  it("returns undefined for unrecognized phrasing", () => {
    expect(restrictionSubject("Do not use this symbol.")).toBeUndefined();
  });
});

describe("normalizeCatalog", () => {
  it("resolves year tokens to per-platform availability", () => {
    const catalog = normalizeCatalog(syntheticRaw(), AT);
    const symbol = catalog.symbols.find((s) => s.name === "testsymbol");
    expect(symbol?.availability).toEqual({ iOS: "13.0", macOS: "10.15" });
    expect(symbol?.layersets).toEqual({
      hierarchical: { iOS: "17.0", macOS: "14.0" },
    });
  });

  it("folds localized variants into their base and keeps orphans as bases", () => {
    const catalog = normalizeCatalog(syntheticRaw(), AT);
    const names = catalog.symbols.map((s) => s.name);
    expect(names).not.toContain("testsymbol.ar");
    expect(names).toContain("orphan.hi");
    const base = catalog.symbols.find((s) => s.name === "testsymbol");
    expect(base?.localizedVariants).toEqual([
      { name: "testsymbol.ar", script: "ar" },
    ]);
  });

  it("marks restrictions and extracts the subject", () => {
    const catalog = normalizeCatalog(syntheticRaw(), AT);
    const restricted = catalog.symbols.find(
      (s) => s.name === "testglyph.badge",
    );
    expect(restricted?.restricted).toBe(true);
    expect(restricted?.restrictionSubject).toBe("TestProduct");
    expect(restricted?.rtlFlippable).toBe(true);
  });

  it("merges aliases from all three sources with kinds", () => {
    const catalog = normalizeCatalog(syntheticRaw(), AT);
    expect(catalog.aliases).toEqual([
      { alias: "ancientname", canonical: "testsymbol", kind: "legacy" },
      { alias: "oldsymbol.name", canonical: "testsymbol.fill", kind: "rename" },
      { alias: "ring", canonical: "testsymbol.fill", kind: "semantic" },
    ]);
  });

  it("records sort order and Apple search terms", () => {
    const catalog = normalizeCatalog(syntheticRaw(), AT);
    const symbol = catalog.symbols.find((s) => s.name === "testsymbol");
    expect(symbol?.sortOrder).toBe(0);
    expect(symbol?.appleSearchTerms).toEqual(["ring", "chime"]);
  });

  it("fails loudly on unknown year tokens", () => {
    const raw = syntheticRaw();
    raw.nameAvailability.symbols["badtoken.symbol"] = "1999";
    expect(() => normalizeCatalog(raw, AT)).toThrow(/unknown year token "1999"/);
  });

  it("fails loudly when an alias points nowhere", () => {
    const raw = syntheticRaw({ nameAliases: { ghost: "does.not.exist" } });
    expect(() => normalizeCatalog(raw, AT)).toThrow(/unknown symbol/);
  });
});
