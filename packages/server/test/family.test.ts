import { describe, expect, it } from "vitest";
import {
  buildFamilies,
  computeFamilyKey,
  validateAgainstFillMap,
} from "../src/search/family.js";

const base = (name: string) => computeFamilyKey(name).baseName;

describe("computeFamilyKey", () => {
  it("strips fill", () => {
    expect(base("bell.fill")).toBe("bell");
    expect(computeFamilyKey("bell.fill").modifiers).toEqual(["fill"]);
  });

  it("strips slash and stacked modifiers", () => {
    expect(base("bell.slash")).toBe("bell");
    expect(base("bell.slash.fill")).toBe("bell");
    expect(base("bell.slash.circle.fill")).toBe("bell");
  });

  it("strips badge with its content", () => {
    expect(base("bell.badge")).toBe("bell");
    expect(base("bell.badge.fill")).toBe("bell");
    expect(base("app.badge.checkmark")).toBe("app");
    expect(base("person.crop.circle.badge.questionmark.fill")).toBe(
      "person.crop",
    );
    expect(computeFamilyKey("person.crop.circle.badge.plus").modifiers).toEqual(
      ["badge.plus", "circle"],
    );
  });

  it("keeps leading badge as a base (badge.plus.radiowaves…)", () => {
    expect(base("badge.plus.radiowaves.right")).toBe(
      "badge.plus.radiowaves.right",
    );
  });

  it("strips enclosures only when a base remains", () => {
    expect(base("person.circle")).toBe("person");
    expect(base("questionmark.circle.fill")).toBe("questionmark");
    expect(base("checkmark.seal.fill")).toBe("checkmark");
    expect(base("circle.fill")).toBe("circle");
    expect(base("circle.grid.3x3")).toBe("circle.grid.3x3");
  });

  it("keeps directional tokens (direction = meaning)", () => {
    expect(base("arrow.down")).toBe("arrow.down");
    expect(base("arrow.up.circle.fill")).toBe("arrow.up");
    expect(base("chevron.left")).toBe("chevron.left");
  });

  it("keeps and-compositions whole", () => {
    expect(base("tray.and.arrow.down")).toBe("tray.and.arrow.down");
    expect(base("tray.and.arrow.down.fill")).toBe("tray.and.arrow.down");
    expect(base("square.and.arrow.up")).toBe("square.and.arrow.up");
  });

  it("strips fill anywhere in compositions", () => {
    expect(base("square.fill.on.circle.fill")).toBe("square.on.circle");
    expect(base("rectangle.fill.on.rectangle.angled.fill")).toBe(
      "rectangle.on.rectangle.angled",
    );
  });

  it("keeps enclosure tokens that follow a connector (composed objects)", () => {
    expect(base("square.on.circle")).toBe("square.on.circle");
    expect(base("square.on.square")).toBe("square.on.square");
  });

  it("strips trailing count tokens", () => {
    expect(base("tray.2")).toBe("tray");
    expect(base("person.3.fill")).toBe("person");
    expect(base("0.circle")).toBe("0");
  });
});

describe("buildFamilies", () => {
  it("groups members and picks the plain base as representative", () => {
    const families = buildFamilies([
      "bell",
      "bell.fill",
      "bell.slash",
      "bell.badge",
      "tray.and.arrow.down",
    ]);
    const bell = families.get("bell");
    expect(bell?.representative).toBe("bell");
    expect(bell?.members).toHaveLength(4);
    expect(families.get("tray.and.arrow.down")?.members).toEqual([
      "tray.and.arrow.down",
    ]);
  });

  it("falls back to the shortest member when the base symbol is missing", () => {
    const families = buildFamilies(["person.crop.circle", "person.crop.square"]);
    const family = families.get("person.crop");
    expect(family?.representative).toBe("person.crop.circle");
  });
});

describe("validateAgainstFillMap", () => {
  it("accepts consistent pairs and reports disagreements", () => {
    expect(
      validateAgainstFillMap({ bell: "bell.fill", "0.circle": "0.circle.fill" }),
    ).toEqual([]);
    const bad = validateAgainstFillMap({ bell: "gear.fill" });
    expect(bad).toHaveLength(1);
    expect(bad[0]?.outlineBase).toBe("bell");
    expect(bad[0]?.fillBase).toBe("gear");
  });
});
