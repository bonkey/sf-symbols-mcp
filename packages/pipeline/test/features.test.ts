import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  computeFeatures,
  hammingDistance,
  phashFromPng,
} from "../src/features.js";

/** Draw a synthetic 256x256 black-on-white PNG from an SVG (invented shapes only). */
async function makePng(dir: string, name: string, svgBody: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/>${svgBody}</svg>`;
  const path = join(dir, `${name}.png`);
  await writeFile(path, await sharp(Buffer.from(svg)).png().toBuffer());
  return path;
}

let dir: string;
let filledSquare: string;
let outlineSquare: string;
let threeDots: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfs-features-"));
  filledSquare = await makePng(
    dir,
    "filled-square",
    `<rect x="64" y="64" width="128" height="128" fill="black"/>`,
  );
  outlineSquare = await makePng(
    dir,
    "outline-square",
    `<rect x="64" y="64" width="128" height="128" fill="none" stroke="black" stroke-width="12"/>`,
  );
  threeDots = await makePng(
    dir,
    "three-dots",
    `<circle cx="64" cy="128" r="20" fill="black"/><circle cx="128" cy="128" r="20" fill="black"/><circle cx="192" cy="128" r="20" fill="black"/>`,
  );
});

describe("computeFeatures", () => {
  it("measures bbox, density, and symmetry of a filled square", async () => {
    const f = await computeFeatures(filledSquare);
    expect(f.bbox.w).toBeGreaterThan(120);
    expect(f.aspectRatio).toBeCloseTo(1, 1);
    expect(f.inkDensity).toBeCloseTo((128 * 128) / (256 * 256), 1);
    expect(f.connectedComponents).toBe(1);
    expect(f.symmetryH).toBeGreaterThan(0.95);
    expect(f.symmetryV).toBeGreaterThan(0.95);
  });

  it("distinguishes filled from outlined shapes via fillScore", async () => {
    const filled = await computeFeatures(filledSquare);
    const outline = await computeFeatures(outlineSquare);
    expect(filled.fillScore).toBeGreaterThan(0.95);
    expect(outline.fillScore).toBeLessThan(0.5);
    expect(outline.complexity).toBeGreaterThan(filled.complexity);
  });

  it("counts connected components", async () => {
    const f = await computeFeatures(threeDots);
    expect(f.connectedComponents).toBe(3);
  });
});

describe("phash", () => {
  it("is stable and format-valid", async () => {
    const a = await phashFromPng(filledSquare);
    const b = await phashFromPng(filledSquare);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates dissimilar shapes more than identical ones", async () => {
    const square = await phashFromPng(filledSquare);
    const dots = await phashFromPng(threeDots);
    expect(hammingDistance(square, square)).toBe(0);
    expect(hammingDistance(square, dots)).toBeGreaterThan(10);
  });
});
