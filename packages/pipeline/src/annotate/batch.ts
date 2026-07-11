import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { GENERATED_DIR } from "../paths.js";
import {
  writeCheckpoint,
  type Checkpoint,
  type PassName,
} from "./store.js";

export interface BatchItem {
  /** Symbol name or family base name; becomes the checkpoint key. */
  key: string;
  params: Anthropic.Messages.MessageCreateParamsNonStreaming;
}

/**
 * Submit one Message Batch for a pass, poll to completion, zod-validate every
 * result, and write per-item checkpoints. Failed/invalid items are returned
 * for a later retry (resume = set-difference against existing checkpoints).
 *
 * custom_ids must match ^[a-zA-Z0-9_-]{1,64}$ and symbol names contain dots,
 * so items get positional ids (i0, i1, …) with the mapping persisted next to
 * the batch state for crash recovery.
 */
export async function runBatchPass<T>(opts: {
  client: Anthropic;
  version: string;
  pass: PassName;
  promptVersion: string;
  model: string;
  items: BatchItem[];
  schema: z.ZodType<T>;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}): Promise<{ succeeded: number; failed: { key: string; reason: string }[] }> {
  const log = opts.log ?? console.log;
  const failed: { key: string; reason: string }[] = [];
  if (opts.items.length === 0) return { succeeded: 0, failed };

  const mapping = new Map<string, string>(
    opts.items.map((item, i) => [`i${i}`, item.key]),
  );

  const batch = await opts.client.messages.batches.create({
    requests: opts.items.map((item, i) => ({
      custom_id: `i${i}`,
      params: item.params,
    })),
  });

  const stateDir = join(GENERATED_DIR, "annotations", opts.version, "batches");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${batch.id}.json`),
    JSON.stringify(
      {
        batchId: batch.id,
        pass: opts.pass,
        promptVersion: opts.promptVersion,
        model: opts.model,
        createdAt: batch.created_at,
        mapping: Object.fromEntries(mapping),
      },
      null,
      2,
    ),
  );
  log(`${opts.pass}: submitted batch ${batch.id} (${opts.items.length} requests)`);

  let status = batch;
  while (status.processing_status !== "ended") {
    await new Promise((resolve) =>
      setTimeout(resolve, opts.pollIntervalMs ?? 30_000),
    );
    status = await opts.client.messages.batches.retrieve(batch.id);
    const c = status.request_counts;
    log(
      `${opts.pass}: ${status.processing_status} — ok ${c.succeeded} / err ${c.errored} / processing ${c.processing}`,
    );
  }

  let succeeded = 0;
  for await (const result of await opts.client.messages.batches.results(
    batch.id,
  )) {
    const key = mapping.get(result.custom_id);
    if (!key) continue;

    if (result.result.type !== "succeeded") {
      failed.push({ key, reason: result.result.type });
      continue;
    }
    const message = result.result.message;
    if (message.stop_reason === "refusal") {
      failed.push({ key, reason: "refusal" });
      continue;
    }
    const text = message.content
      .filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      )
      .map((b) => b.text)
      .join("");
    let value: T;
    try {
      value = opts.schema.parse(JSON.parse(text));
    } catch (error) {
      failed.push({
        key,
        reason: `invalid output: ${error instanceof Error ? error.message.slice(0, 200) : "parse error"}`,
      });
      continue;
    }
    const checkpoint: Checkpoint<T> = {
      key,
      pass: opts.pass,
      promptVersion: opts.promptVersion,
      model: opts.model,
      batchId: batch.id,
      timestamp: status.ended_at ?? new Date().toISOString(),
      value,
    };
    await writeCheckpoint(opts.version, checkpoint);
    succeeded++;
  }

  log(`${opts.pass}: ${succeeded} checkpointed, ${failed.length} failed`);
  return { succeeded, failed };
}
