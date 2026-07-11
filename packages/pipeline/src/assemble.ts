import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeterministicFeatures, SymbolAnnotations } from "@sfsmcp/schema";
import {
  Pass1LiteralSchema,
  Pass2SemanticSchema,
  Pass3ReconcileSchema,
} from "@sfsmcp/schema";
import { FEATURE_VERSION } from "./features.js";
import { GENERATED_DIR } from "./paths.js";
import { readCheckpoint, type Checkpoint } from "./annotate/store.js";

const provenanceOf = (checkpoint: Checkpoint) => ({
  source: "vision-model" as const,
  model: checkpoint.model,
  promptVersion: checkpoint.promptVersion,
  batchId: checkpoint.batchId,
  timestamp: checkpoint.timestamp,
});

export interface AssembledData {
  annotations: Map<string, SymbolAnnotations>;
  familyAnalyses: Map<string, unknown>;
}

/** Names flagged by the consensus pass as disagreeing between models. */
async function loadDisagreements(version: string): Promise<Set<string>> {
  try {
    const report = JSON.parse(
      await readFile(
        join(GENERATED_DIR, "annotations", version, "disagreements.json"),
        "utf8",
      ),
    ) as { name: string }[];
    return new Set(report.map((r) => r.name));
  } catch {
    return new Set();
  }
}

async function loadFeatures(
  version: string,
): Promise<Record<string, DeterministicFeatures>> {
  try {
    const parsed = JSON.parse(
      await readFile(
        join(GENERATED_DIR, "features", version, "features.json"),
        "utf8",
      ),
    ) as { features: Record<string, DeterministicFeatures> };
    return parsed.features;
  } catch {
    return {};
  }
}

/**
 * Assemble per-symbol SymbolAnnotations records from the pass checkpoints
 * and deterministic features. Symbols without any checkpoint get an entry
 * only if features exist for them.
 */
export async function assembleAnnotations(
  version: string,
  names: string[],
): Promise<Map<string, SymbolAnnotations>> {
  const disagreements = await loadDisagreements(version);
  const features = await loadFeatures(version);
  const result = new Map<string, SymbolAnnotations>();

  for (const name of names) {
    const p1 = await readCheckpoint(version, "pass1", name, Pass1LiteralSchema);
    const p2 = await readCheckpoint(version, "pass2", name, Pass2SemanticSchema);
    const p3 = await readCheckpoint(version, "pass3", name, Pass3ReconcileSchema);
    const feat = features[name];
    if (!p1 && !p2 && !p3 && !feat) continue;

    result.set(name, {
      name,
      ...(p1 && { literal: { value: p1.value, provenance: provenanceOf(p1) } }),
      ...(p2 && { semantic: { value: p2.value, provenance: provenanceOf(p2) } }),
      ...(p3 && {
        reconciled: { value: p3.value, provenance: provenanceOf(p3) },
      }),
      ...(feat && {
        features: {
          value: feat,
          provenance: {
            source: "computed" as const,
            featureVersion: FEATURE_VERSION,
          },
        },
      }),
      disagreement: disagreements.has(name),
    });
  }
  return result;
}
