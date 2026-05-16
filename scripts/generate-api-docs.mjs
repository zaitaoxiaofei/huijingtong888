import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiDocumentation, renderApiDocumentationMarkdown } from "../src/server/api-docs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputPath = path.join(projectRoot, "docs", "BACKEND_API_REFERENCE.md");

const catalog = {
  ...createApiDocumentation(),
  generatedAt: "SOURCE_CONTROLLED"
};
const markdown = renderApiDocumentationMarkdown(catalog);

await fs.writeFile(outputPath, markdown, "utf8");

console.log(`API reference written to ${outputPath}`);
console.log(`Documented sections: ${catalog.sections.length}`);
console.log(
  `Documented endpoints: ${catalog.sections.reduce((sum, section) => sum + section.endpoints.length, 0)}`
);
