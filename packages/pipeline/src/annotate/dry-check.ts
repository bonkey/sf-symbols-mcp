/** Dry validation of request construction — no API calls. Run: tsx src/annotate/dry-check.ts */
import { join } from "node:path";
import { GENERATED_DIR } from "../paths.js";
import { pass1Request } from "./requests.js";

const rendersDir = join(GENERATED_DIR, "renders", "7.2");
const req = await pass1Request(rendersDir, "bell", "claude-sonnet-5");

console.log("model:", req.model, "| max_tokens:", req.max_tokens);
console.log("effort:", req.output_config?.effort);
const format = req.output_config?.format as { type: string; schema?: unknown };
console.log("format type:", format?.type);
const schemaJson = JSON.stringify(format?.schema ?? format);
console.log(
  "schema has unsupported constraints:",
  /"(minimum|maximum|minLength|maxLength)"/.test(schemaJson),
);
console.log(
  "schema additionalProperties:false present:",
  schemaJson.includes('"additionalProperties":false'),
);
const content = req.messages[0]?.content;
const image = Array.isArray(content) ? (content[0] as { source: { data: string } }) : null;
console.log("image base64 length:", image?.source.data.length);
console.log("request JSON size KB:", Math.round(JSON.stringify(req).length / 1024));
console.log("schema:", schemaJson.slice(0, 400));
