import type Anthropic from "@anthropic-ai/sdk";
import { Agent } from "undici";
import type { z } from "zod";
import {
  writeCheckpoint,
  type Checkpoint,
  type PassName,
} from "./store.js";
import type { BatchItem } from "./batch.js";

/**
 * OpenRouter transport for the annotation passes — same contract as the
 * Anthropic batch runner (items in, checkpoints out, set-difference resume),
 * but over the OpenAI-compatible /chat/completions endpoint with a bounded
 * concurrent pool instead of a batch job. Lets the passes run on cheap
 * vision models (Gemini Flash class) for a few dollars total.
 *
 * Auth: OPENROUTER_API_KEY. Model names are OpenRouter ids, e.g.
 * "google/gemini-2.5-flash" — see https://openrouter.ai/models.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Dedicated connection pool. Node's default fetch dispatcher was observed
 * funnelling every request through a single keep-alive socket in this
 * process shape, serializing the whole pool (~45 req/min regardless of
 * worker count). An explicit Agent restores real parallelism.
 */
const dispatcher = new Agent({ connections: 128, pipelining: 1 });

interface OpenAiMessage {
  role: "system" | "user";
  content:
    | string
    | (
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      )[];
}

/** Convert our Anthropic-format request params to an OpenAI-compatible body. */
export function toOpenRouterBody(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  model: string,
  routeOnly?: string,
): Record<string, unknown> {
  const messages: OpenAiMessage[] = [];
  if (typeof params.system === "string") {
    messages.push({ role: "system", content: params.system });
  }
  for (const message of params.messages) {
    if (message.role !== "user") continue;
    const content = Array.isArray(message.content)
      ? message.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          if (block.type === "image" && block.source.type === "base64") {
            return {
              type: "image_url" as const,
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            };
          }
          throw new Error(`unsupported content block: ${block.type}`);
        })
      : message.content;
    messages.push({ role: "user", content });
  }

  const format = params.output_config?.format as
    | { type: string; schema?: unknown; name?: string }
    | undefined;

  return {
    model,
    messages,
    max_tokens: params.max_tokens,
    // Pin the upstream provider (e.g. "google-vertex") to bypass a BYOK
    // integration whose upstream key is rate-limited.
    ...(routeOnly && {
      provider: { only: [routeOnly], allow_fallbacks: false },
    }),
    ...(format?.type === "json_schema" && {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "annotation",
          strict: true,
          schema: format.schema,
        },
      },
    }),
  };
}

/** Extract JSON from a model reply that may be fenced or padded with prose. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/bonkey/sf-symbols-mcp",
          "X-Title": "sf-symbols-mcp annotation pipeline",
        },
        body: JSON.stringify(body),
        // Hung sockets must fail fast and retry on a fresh connection —
        // observed stalls otherwise cap throughput regardless of pool size.
        signal: AbortSignal.timeout(60_000),
        // Non-standard Node extension: route through the dedicated pool.
        dispatcher,
      } as unknown as RequestInit);
    } catch (error) {
      lastError =
        error instanceof Error ? `${error.name}: ${error.message}` : "network error";
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = `HTTP ${response.status}`;
      continue;
    }
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const json = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      error?: { message?: string };
    };
    if (json.error) throw new Error(`OpenRouter error: ${json.error.message}`);
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      lastError = "empty completion";
      continue;
    }
    return content;
  }
  throw new Error(`OpenRouter failed after retries: ${lastError}`);
}

export async function runOpenRouterPass<T>(opts: {
  version: string;
  pass: PassName;
  promptVersion: string;
  model: string;
  items: BatchItem[];
  schema: z.ZodType<T>;
  concurrency?: number;
  routeOnly?: string | undefined;
  log?: (message: string) => void;
}): Promise<{ succeeded: number; failed: { key: string; reason: string }[] }> {
  const log = opts.log ?? console.log;
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  const failed: { key: string; reason: string }[] = [];
  let succeeded = 0;
  let next = 0;
  let done = 0;

  const worker = async (startDelayMs: number) => {
    // Stagger startup so a wide pool doesn't open all connections at once.
    await new Promise((r) => setTimeout(r, startDelayMs));
    for (;;) {
      const index = next++;
      const item = opts.items[index];
      if (!item) return;
      try {
        const body = toOpenRouterBody(item.params, opts.model, opts.routeOnly);
        const text = await callOpenRouter(apiKey, body);
        const value = opts.schema.parse(JSON.parse(extractJson(text)));
        const checkpoint: Checkpoint<T> = {
          key: item.key,
          pass: opts.pass,
          promptVersion: opts.promptVersion,
          model: `openrouter:${opts.model}`,
          batchId: "openrouter",
          timestamp: new Date().toISOString(),
          value,
        };
        await writeCheckpoint(opts.version, checkpoint);
        succeeded++;
      } catch (error) {
        failed.push({
          key: item.key,
          reason:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
      if (++done % 100 === 0) {
        log(`${opts.pass}: ${done}/${opts.items.length} (${failed.length} failed)`);
      }
    }
  };

  const poolSize = Math.min(opts.concurrency ?? 8, opts.items.length);
  await Promise.all(
    Array.from({ length: poolSize }, (_, i) => worker(i * 100)),
  );
  log(`${opts.pass}: ${succeeded} checkpointed, ${failed.length} failed`);
  return { succeeded, failed };
}
