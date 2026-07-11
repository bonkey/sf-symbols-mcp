/**
 * Maintainer pipeline CLI: extract | render | features | annotate | build-db.
 * Subcommands are wired in as their milestones land.
 */
const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {};

const run = commands[command ?? ""];
if (!run) {
  console.error(
    `Unknown or not-yet-implemented command: ${command ?? "(none)"}\n` +
      `Available: ${Object.keys(commands).join(", ") || "(none yet)"}`,
  );
  process.exit(2);
}
await run();
