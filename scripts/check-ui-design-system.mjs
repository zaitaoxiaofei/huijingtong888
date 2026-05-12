import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const baselinePath = join(root, "scripts/ui-design-system-baseline.json");
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : { maxWarnings: Number.POSITIVE_INFINITY };
const files = [
  "public/styles.css",
  "public/design-system.css"
];

const allowedFiles = new Set(["public/design-system.css"]);
const patterns = [
  { name: "hardcoded hex color", regex: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "hardcoded radius", regex: /border-radius:(?!\s*var\()[^;]+;/g },
  { name: "hardcoded shadow", regex: /box-shadow:(?!\s*var\()[^;]+;/g }
];

let warnings = 0;
const verbose = process.argv.includes("--verbose");
const samples = [];

for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  const lines = text.split(/\r?\n/);
  const isAllowedTokenFile = allowedFiles.has(file);
  lines.forEach((line, index) => {
    if (isAllowedTokenFile) return;
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        warnings += 1;
        const message = `[ui-design-system] ${file}:${index + 1} ${pattern.name}: ${line.trim()}`;
        if (verbose) console.warn(message);
        else if (samples.length < 30) samples.push(message);
      }
      pattern.regex.lastIndex = 0;
    }
  });
}

if (warnings) {
  if (!verbose) samples.forEach((message) => console.warn(message));
  console.warn(`[ui-design-system] Found ${warnings} legacy style entries. Prefer design-system tokens for new code.`);
  if (!verbose && warnings > samples.length) {
    console.warn("[ui-design-system] Showing first 30 only. Run `node scripts/check-ui-design-system.mjs --verbose` for the full list.");
  }
  if (Number.isFinite(baseline.maxWarnings) && warnings > baseline.maxWarnings) {
    console.error(`[ui-design-system] Warning count increased above baseline ${baseline.maxWarnings}. New UI must use Design System tokens.`);
    process.exitCode = 1;
  }
} else {
  console.log("[ui-design-system] No token violations found.");
}
