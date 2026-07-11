import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Licensing guard: Apple artwork, fonts, asset catalogs, and Apple-authored
 * metadata files must never be committed to this repository. See NOTICE and
 * the licensing risk matrix in the project plan.
 */

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const FORBIDDEN_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".pdf",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
  ".car",
];

const APPLE_METADATA_BASENAMES = [
  "name_availability.plist",
  "symbol_categories.plist",
  "symbol_search.plist",
  "layerset_availability.plist",
  "name_aliases.strings",
  "legacy_aliases.strings",
  "symbol_restrictions.strings",
  "symbol_order.plist",
  "nofill_to_fill.strings",
  "legacy_flippable.plist",
  "semantic_to_descriptive_name.strings",
  "categories.plist",
];

describe("licensing CI guard", () => {
  const files = trackedFiles();

  it("contains no image, font, or asset-catalog files", () => {
    const offenders = files.filter((f) =>
      FORBIDDEN_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)),
    );
    expect(offenders).toEqual([]);
  });

  it("contains no Apple metadata files by name", () => {
    const offenders = files.filter((f) => {
      const base = f.split("/").at(-1) ?? "";
      return APPLE_METADATA_BASENAMES.includes(base);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps plist/strings files confined to synthetic fixtures", () => {
    const offenders = files.filter(
      (f) =>
        (f.endsWith(".plist") || f.endsWith(".strings")) &&
        !f.startsWith("fixtures/"),
    );
    expect(offenders).toEqual([]);
  });

  it("does not track anything under generated-local/", () => {
    const offenders = files.filter((f) => f.startsWith("generated-local/"));
    expect(offenders).toEqual([]);
  });
});
