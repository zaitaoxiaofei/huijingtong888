import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiDocumentation, renderApiDocumentationMarkdown } from "../src/server/api-docs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const targetPath = path.join(projectRoot, "docs", "BACKEND_API_REFERENCE.md");

const actual = await fs.readFile(targetPath, "utf8");
const expected = renderApiDocumentationMarkdown({
  ...createApiDocumentation(),
  generatedAt: "SOURCE_CONTROLLED"
});

if (actual !== expected) {
  console.error("API documentation drift detected.");
  console.error("Run `npm run docs:api` and commit the updated docs/BACKEND_API_REFERENCE.md file.");
  process.exit(1);
}

console.log("API documentation is up to date.");
