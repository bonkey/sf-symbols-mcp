import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { GENERATED_DIR } from "../paths.js";

export type PassName = "pass1" | "pass1b" | "pass2" | "pass3" | "family";

/** One stored annotation checkpoint: the validated model output + provenance. */
export interface Checkpoint<T = unknown> {
  key: string; // symbol name, or family base name for the family pass
  pass: PassName;
  promptVersion: string;
  model: string;
  batchId: string;
  timestamp: string;
  value: T;
}

const passDir = (version: string, pass: PassName) =>
  join(GENERATED_DIR, "annotations", version, pass);

/** Filesystem-safe file name for a symbol/family key (names contain dots only). */
const fileFor = (key: string) => `${key}.json`;

export async function listCheckpoints(
  version: string,
  pass: PassName,
): Promise<Set<string>> {
  const files = await readdir(passDir(version, pass)).catch(() => []);
  return new Set(
    files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)),
  );
}

export async function readCheckpoint<T>(
  version: string,
  pass: PassName,
  key: string,
  schema: z.ZodType<T>,
): Promise<Checkpoint<T> | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(passDir(version, pass), fileFor(key)), "utf8"),
    ) as Checkpoint;
    return { ...raw, value: schema.parse(raw.value) };
  } catch {
    return null;
  }
}

export async function writeCheckpoint(
  version: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const dir = passDir(version, checkpoint.pass);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, fileFor(checkpoint.key)),
    JSON.stringify(checkpoint, null, 2),
  );
}
