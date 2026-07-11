import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Convert any plist flavor (XML, binary, old-style ASCII .strings) to JSON via
 * the system `plutil`. This is the only parser that handles all three formats
 * present in the SF Symbols catalog; it exists on every macOS and extraction
 * only ever runs on macOS.
 *
 * Known limitation: `plutil -convert json` rejects plists containing <data>
 * or <date> values. None of the catalog files contain them today; if that
 * changes the caller sees a loud error naming the file.
 */
export async function plutilToJson(path: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-convert", "json", "-o", "-", path],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`plutil failed to convert ${path} to JSON`, { cause });
  }
}
