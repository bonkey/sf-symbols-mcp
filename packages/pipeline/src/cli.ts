/**
 * Maintainer pipeline CLI: extract | render | features | annotate | build-db.
 * Subcommands are wired in as their milestones land.
 */
import { runAnnotate } from "./annotate/run.js";
import { runBuildDb } from "./build-db.js";
import { runExtract } from "./extract.js";
import { runFeatures } from "./features.js";
import { runRender } from "./render.js";

const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  extract: runExtract,
  render: runRender,
  features: runFeatures,
  annotate: runAnnotate,
  "build-db": runBuildDb,
};

const run = commands[command ?? ""];
if (!run) {
  console.error(
    `Unknown or not-yet-implemented command: ${command ?? "(none)"}\n` +
      `Available: ${Object.keys(commands).join(", ")}`,
  );
  process.exit(2);
}
await run();
