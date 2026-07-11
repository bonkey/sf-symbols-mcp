import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { ExtractedSymbol } from "@sfsmcp/schema";
import {
  Pass1LiteralSchema,
  Pass2SemanticSchema,
  Pass3ReconcileSchema,
  FamilyAnalysisSchema,
} from "@sfsmcp/schema";
import {
  FAMILY_PROMPT,
  FAMILY_SYSTEM,
  PASS1_PROMPT,
  PASS1_SYSTEM,
  PASS1B_PROMPT,
  PASS2_PROMPT,
  PASS2_SYSTEM,
  PASS3_PROMPT,
  PASS3_SYSTEM,
} from "./prompts.js";

/** Models that support the effort parameter (Haiku 4.5 rejects it). */
const supportsEffort = (model: string) => !model.includes("haiku");

const MAX_TOKENS = 4000;

function baseParams(
  model: string,
  system: string,
  format: ReturnType<typeof zodOutputFormat>,
): Pick<
  Anthropic.Messages.MessageCreateParamsNonStreaming,
  "model" | "max_tokens" | "system" | "output_config"
> {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system,
    output_config: {
      format,
      ...(supportsEffort(model) && { effort: "medium" as const }),
    },
  };
}

export async function imageBlock(
  rendersDir: string,
  name: string,
): Promise<Anthropic.Messages.ImageBlockParam> {
  const data = await readFile(join(rendersDir, `${name}.png`));
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: data.toString("base64"),
    },
  };
}

export async function pass1Request(
  rendersDir: string,
  name: string,
  model: string,
  alternate = false,
): Promise<Anthropic.Messages.MessageCreateParamsNonStreaming> {
  return {
    ...baseParams(model, PASS1_SYSTEM, zodOutputFormat(Pass1LiteralSchema)),
    messages: [
      {
        role: "user",
        content: [
          await imageBlock(rendersDir, name),
          { type: "text", text: alternate ? PASS1B_PROMPT : PASS1_PROMPT },
        ],
      },
    ],
  };
}

export async function pass2Request(
  rendersDir: string,
  name: string,
  model: string,
  pass1: z.infer<typeof Pass1LiteralSchema>,
): Promise<Anthropic.Messages.MessageCreateParamsNonStreaming> {
  return {
    ...baseParams(model, PASS2_SYSTEM, zodOutputFormat(Pass2SemanticSchema)),
    messages: [
      {
        role: "user",
        content: [
          await imageBlock(rendersDir, name),
          { type: "text", text: PASS2_PROMPT(JSON.stringify(pass1, null, 1)) },
        ],
      },
    ],
  };
}

/**
 * Pass 3 metadata deliberately excludes Apple's search keywords: mined
 * aliases must derive from the name and glyph only, so the published
 * annotations stay independently authored (see the licensing policy).
 */
export function pass3Metadata(symbol: ExtractedSymbol): string {
  return JSON.stringify(
    {
      categories: symbol.categories,
      availability: symbol.availability,
      restricted: symbol.restricted,
      ...(symbol.restrictionSubject !== undefined && {
        restrictionSubject: symbol.restrictionSubject,
      }),
    },
    null,
    1,
  );
}

export async function pass3Request(
  rendersDir: string,
  symbol: ExtractedSymbol,
  model: string,
  pass1: z.infer<typeof Pass1LiteralSchema>,
  pass2: z.infer<typeof Pass2SemanticSchema>,
): Promise<Anthropic.Messages.MessageCreateParamsNonStreaming> {
  return {
    ...baseParams(model, PASS3_SYSTEM, zodOutputFormat(Pass3ReconcileSchema)),
    messages: [
      {
        role: "user",
        content: [
          await imageBlock(rendersDir, symbol.name),
          {
            type: "text",
            text: PASS3_PROMPT({
              name: symbol.name,
              metadataJson: pass3Metadata(symbol),
              pass1Json: JSON.stringify(pass1, null, 1),
              pass2Json: JSON.stringify(pass2, null, 1),
            }),
          },
        ],
      },
    ],
  };
}

export function familyRequest(
  baseName: string,
  members: { name: string; description: string }[],
  model: string,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    ...baseParams(model, FAMILY_SYSTEM, zodOutputFormat(FamilyAnalysisSchema)),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: FAMILY_PROMPT({
              baseName,
              membersJson: JSON.stringify(members, null, 1),
            }),
          },
        ],
      },
    ],
  };
}
