import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ExtractedCatalog, ExtractedSymbol } from "@sfsmcp/schema";
import {
  FamilyAnalysisSchema,
  Pass1LiteralSchema,
  Pass1LiteralWireSchema,
  Pass2SemanticSchema,
  Pass3ReconcileSchema,
} from "@sfsmcp/schema";
import { buildFamilies } from "sf-symbols-mcp/search/family";
import { annotatableSymbols, loadExtractedCatalog } from "../catalog.js";
import { GENERATED_DIR } from "../paths.js";
import { runBatchPass, type BatchItem } from "./batch.js";
import { runOpenRouterPass } from "./openrouter.js";
import { PROMPT_VERSIONS } from "./prompts.js";
import {
  familyRequest,
  pass1Request,
  pass2Request,
  pass3Request,
} from "./requests.js";
import { listCheckpoints, readCheckpoint, type PassName } from "./store.js";

type Provider = "anthropic" | "openrouter";

const DEFAULTS: Record<Provider, { model: string; consensusModel: string }> = {
  anthropic: { model: "claude-sonnet-5", consensusModel: "claude-haiku-4-5" },
  // Cheap OpenRouter vision models — override with --model=<openrouter id>,
  // see https://openrouter.ai/models (any vision model with JSON output works).
  openrouter: {
    model: "google/gemini-2.5-flash",
    consensusModel: "openai/gpt-4o-mini",
  },
};

function resolveProvider(argv: string[]): Provider {
  const flag = argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
  if (flag === "anthropic" || flag === "openrouter") return flag;
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic";
  if (process.env["OPENROUTER_API_KEY"]) return "openrouter";
  console.error(
    "No API credential found. Set OPENROUTER_API_KEY (cheap, recommended) or " +
      "ANTHROPIC_API_KEY, optionally with --provider=openrouter|anthropic.",
  );
  process.exit(3);
}

interface Options {
  pass: string;
  pilot?: number;
  yes: boolean;
  provider: Provider;
  model: string;
  consensusModel: string;
  concurrency: number;
  route?: string;
  /** "i/n": process only names whose stable hash ≡ i (mod n) — disjoint parallel shards. */
  shard?: [number, number];
}

function parseOptions(argv: string[]): Options {
  const pass = argv.find((a) => !a.startsWith("--")) ?? "status";
  const pilotArg = argv.find((a) => a.startsWith("--pilot"));
  const modelArg = argv.find((a) => a.startsWith("--model="));
  const provider = pass === "status" ? "anthropic" : resolveProvider(argv);
  return {
    pass,
    ...(pilotArg && {
      pilot: Number.parseInt(pilotArg.split("=")[1] ?? "50", 10),
    }),
    yes: argv.includes("--yes"),
    provider,
    model: modelArg?.split("=")[1] ?? DEFAULTS[provider].model,
    consensusModel: DEFAULTS[provider].consensusModel,
    concurrency: Number.parseInt(
      argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "8",
      10,
    ),
    ...(argv.find((a) => a.startsWith("--route=")) && {
      route: argv.find((a) => a.startsWith("--route="))?.split("=")[1] as string,
    }),
    ...(argv.find((a) => a.startsWith("--shard=")) && {
      shard: (argv.find((a) => a.startsWith("--shard="))?.split("=")[1] ?? "0/1")
        .split("/")
        .map(Number) as [number, number],
    }),
  };
}

/** Deterministic pilot subset: sort by sha256(name), take N. */
function pilotSubset(names: string[], n: number): string[] {
  return [...names]
    .sort((a, b) => {
      const ha = createHash("sha256").update(a).digest("hex");
      const hb = createHash("sha256").update(b).digest("hex");
      return ha < hb ? -1 : 1;
    })
    .slice(0, n);
}

async function confirmSpend(
  requestCount: number,
  approxInputPerReq: number,
  opts: Options,
): Promise<void> {
  // Anthropic: Sonnet-5 batch rates ($1.50/M in, $7.50/M out, ~600 out/req).
  // OpenRouter: Gemini-Flash-class rates (~$0.30/M in, ~$2.50/M out).
  const inputM = (requestCount * approxInputPerReq) / 1e6;
  const outputM = (requestCount * 600) / 1e6;
  const cost =
    opts.provider === "anthropic"
      ? inputM * 1.5 + outputM * 7.5
      : inputM * 0.3 + outputM * 2.5;
  console.log(
    `About to submit ${requestCount} requests via ${opts.provider} (${opts.model}), ` +
      `~$${cost.toFixed(2)} estimated.`,
  );
  if (!opts.yes) {
    console.error("Re-run with --yes to confirm the spend.");
    process.exit(3);
  }
}

type Pass1 = z.infer<typeof Pass1LiteralSchema>;
type Pass2 = z.infer<typeof Pass2SemanticSchema>;
type Pass3 = z.infer<typeof Pass3ReconcileSchema>;

function shardOf(name: string, n: number): number {
  const hex = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) % n;
}

async function targetNames(
  catalog: ExtractedCatalog,
  opts: Options,
): Promise<string[]> {
  let names = annotatableSymbols(catalog);
  if (opts.shard) {
    const [i, n] = opts.shard;
    names = names.filter((name) => shardOf(name, n) === i);
  }
  return opts.pilot ? pilotSubset(names, opts.pilot) : names;
}

export async function runAnnotate(): Promise<void> {
  const opts = parseOptions(process.argv.slice(3));
  const catalog = await loadExtractedCatalog();
  const version = catalog.sfSymbolsVersion;
  const rendersDir = join(GENERATED_DIR, "renders", version);
  const symbolsByName = new Map(catalog.symbols.map((s) => [s.name, s]));

  const names = await targetNames(catalog, opts);

  /** Dispatch a pass to the selected transport (Anthropic batches or OpenRouter pool). */
  const execute = async (args: {
    pass: PassName;
    promptVersion: string;
    model: string;
    items: BatchItem[];
    schema: z.ZodType<unknown>;
  }) => {
    if (opts.provider === "openrouter") {
      return runOpenRouterPass({ version, concurrency: opts.concurrency, routeOnly: opts.route, ...args });
    }
    return runBatchPass({ client: new Anthropic(), version, ...args });
  };

  const status = async () => {
    for (const pass of ["pass1", "pass2", "pass3", "pass1b", "family"] as const) {
      const done = await listCheckpoints(version, pass);
      console.log(`${pass}: ${done.size} checkpoints`);
    }
  };

  const runPass1 = async () => {
    const done = await listCheckpoints(version, "pass1");
    const pending = names.filter((n) => !done.has(n));
    console.log(`pass1: ${pending.length} pending of ${names.length}`);
    if (pending.length === 0) return;
    await confirmSpend(pending.length, 1000, opts);
    const items: BatchItem[] = [];
    for (const name of pending) {
      items.push({
        key: name,
        params: await pass1Request(rendersDir, name, opts.model),
      });
    }
    await execute({
      pass: "pass1",
      promptVersion: PROMPT_VERSIONS.pass1,
      model: opts.model,
      items,
      schema: Pass1LiteralWireSchema,
    });
  };

  const runPass2 = async () => {
    const havePass1 = await listCheckpoints(version, "pass1");
    const done = await listCheckpoints(version, "pass2");
    const pending = names.filter((n) => havePass1.has(n) && !done.has(n));
    console.log(`pass2: ${pending.length} pending`);
    if (pending.length === 0) return;
    await confirmSpend(pending.length, 1400, opts);
    const items: BatchItem[] = [];
    for (const name of pending) {
      const p1 = await readCheckpoint(version, "pass1", name, Pass1LiteralSchema);
      if (!p1) continue;
      items.push({
        key: name,
        params: await pass2Request(rendersDir, name, opts.model, p1.value),
      });
    }
    await execute({
      pass: "pass2",
      promptVersion: PROMPT_VERSIONS.pass2,
      model: opts.model,
      items,
      schema: Pass2SemanticSchema,
    });
  };

  const runPass3 = async () => {
    const havePass2 = await listCheckpoints(version, "pass2");
    const done = await listCheckpoints(version, "pass3");
    const pending = names.filter((n) => havePass2.has(n) && !done.has(n));
    console.log(`pass3: ${pending.length} pending`);
    if (pending.length === 0) return;
    await confirmSpend(pending.length, 2200, opts);
    const items: BatchItem[] = [];
    for (const name of pending) {
      const symbol = symbolsByName.get(name) as ExtractedSymbol;
      const p1 = await readCheckpoint(version, "pass1", name, Pass1LiteralSchema);
      const p2 = await readCheckpoint(version, "pass2", name, Pass2SemanticSchema);
      if (!p1 || !p2) continue;
      items.push({
        key: name,
        params: await pass3Request(rendersDir, symbol, opts.model, p1.value, p2.value),
      });
    }
    await execute({
      pass: "pass3",
      promptVersion: PROMPT_VERSIONS.pass3,
      model: opts.model,
      items,
      schema: Pass3ReconcileSchema,
    });
  };

  const runFamily = async () => {
    const havePass3 = await listCheckpoints(version, "pass3");
    const done = await listCheckpoints(version, "family");
    const families = buildFamilies(names);
    const targets = [...families.values()].filter(
      (f) =>
        f.members.length > 1 &&
        !done.has(f.baseName) &&
        f.members.every((m) => havePass3.has(m)),
    );
    console.log(`family: ${targets.length} pending multi-member families`);
    if (targets.length === 0) return;
    await confirmSpend(targets.length, 1800, opts);
    const items: BatchItem[] = [];
    for (const family of targets) {
      const members: { name: string; description: string }[] = [];
      for (const member of family.members) {
        const p3 = await readCheckpoint(version, "pass3", member, Pass3ReconcileSchema);
        if (p3) {
          members.push({ name: member, description: p3.value.finalDescription });
        }
      }
      items.push({
        key: family.baseName,
        params: familyRequest(family.baseName, members, opts.model),
      });
    }
    await execute({
      pass: "family",
      promptVersion: PROMPT_VERSIONS.family,
      model: opts.model,
      items,
      schema: FamilyAnalysisSchema,
    });
  };

  /** Consensus: re-run pass1 with the alternate prompt on a different model for low-confidence/contradictory symbols. */
  const runConsensus = async () => {
    const done = await listCheckpoints(version, "pass1b");
    const triggers: string[] = [];
    for (const name of names) {
      if (done.has(name)) continue;
      const p1 = await readCheckpoint(version, "pass1", name, Pass1LiteralSchema);
      const p3 = await readCheckpoint(version, "pass3", name, Pass3ReconcileSchema);
      if (!p1 || !p3) continue;
      if (
        p1.value.confidence < 0.6 ||
        !p3.value.nameGlyphConsistent ||
        p3.value.contradictions.length > 0
      ) {
        triggers.push(name);
      }
    }
    console.log(`consensus: ${triggers.length} triggered symbols`);
    if (triggers.length === 0) return;
    await confirmSpend(triggers.length, 1000, opts);
    const items: BatchItem[] = [];
    for (const name of triggers) {
      items.push({
        key: name,
        params: await pass1Request(rendersDir, name, opts.consensusModel, true),
      });
    }
    await execute({
      pass: "pass1b",
      promptVersion: PROMPT_VERSIONS.pass1b,
      model: opts.consensusModel,
      items,
      schema: Pass1LiteralWireSchema,
    });
    await writeDisagreementReport(version, names);
  };

  switch (opts.pass) {
    case "status":
      await status();
      break;
    case "pass1":
      await runPass1();
      break;
    case "pass2":
      await runPass2();
      break;
    case "pass3":
      await runPass3();
      break;
    case "family":
      await runFamily();
      break;
    case "consensus":
      await runConsensus();
      break;
    case "all":
      await runPass1();
      await runPass2();
      await runPass3();
      await runFamily();
      await runConsensus();
      break;
    default:
      console.error(
        `Unknown pass "${opts.pass}". Use: status | pass1 | pass2 | pass3 | family | consensus | all [--pilot=N] [--yes] [--model=…]`,
      );
      process.exit(2);
  }
}

/** Jaccard agreement between two pass-1 analyses on primary objects. */
function pass1Agreement(a: Pass1, b: Pass1): number {
  const setA = new Set(a.primaryObjects.map((o) => o.toLowerCase()));
  const setB = new Set(b.primaryObjects.map((o) => o.toLowerCase()));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

async function writeDisagreementReport(
  version: string,
  names: string[],
): Promise<void> {
  const haveB = await listCheckpoints(version, "pass1b");
  const report: {
    name: string;
    agreement: number;
    primaryA: string[];
    primaryB: string[];
    enclosureMatch: boolean;
  }[] = [];
  for (const name of names) {
    if (!haveB.has(name)) continue;
    const a = await readCheckpoint(version, "pass1", name, Pass1LiteralSchema);
    const b = await readCheckpoint(version, "pass1b", name, Pass1LiteralSchema);
    if (!a || !b) continue;
    const agreement = pass1Agreement(a.value, b.value);
    const enclosureMatch = a.value.enclosure === b.value.enclosure;
    if (agreement < 0.5 || !enclosureMatch) {
      report.push({
        name,
        agreement: Number(agreement.toFixed(2)),
        primaryA: a.value.primaryObjects,
        primaryB: b.value.primaryObjects,
        enclosureMatch,
      });
    }
  }
  const dir = join(GENERATED_DIR, "annotations", version);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "disagreements.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `consensus: ${report.length} disagreements → annotations/${version}/disagreements.json`,
  );
}
