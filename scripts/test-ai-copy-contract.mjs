import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { chatWithAiProvider } from "../src/services/ai-provider-settings.js";
import { buildCopyBundlePrompt, buildCopyFactsContract } from "../src/server/services/ai/copyFactsContract.js";
import { parseCopyBundleResponse, validateCopyBundle } from "../src/server/services/ai/copyQualityValidator.js";

const args = parseArgs(process.argv.slice(2));
const draftIds = args.ids.length ? args.ids : [342, 295];
const runAi = !args.noAi;
const strategy = args.strategy || "precision_fit";

try {
  const placeholders = draftIds.map(() => "?").join(", ");
  const rows = await mysqlQuery(`SELECT * FROM listing_drafts WHERE id IN (${placeholders}) ORDER BY id`, draftIds);
  if (!rows.length) {
    console.log("No listing drafts found:", draftIds.join(", "));
    process.exitCode = 1;
  }

  for (const row of rows) {
    const contract = buildCopyFactsContract({
      draft: row,
      targetModel: args.targetById[String(row.id)] || "",
      material: args.materialById[String(row.id)] || "",
      color: args.colorById[String(row.id)] || "",
      quantity: args.quantityById[String(row.id)] || ""
    });
    const existingBundle = {
      title: contract.source.title,
      tags: contract.source.sourceTags,
      description: contract.source.originalDescription
    };
    const existingReport = validateCopyBundle(existingBundle, contract);
    const prompt = buildCopyBundlePrompt(contract, { strategy });

    printSection(`DRAFT ${row.id}`);
    console.log("Title:", contract.source.title);
    console.log("Category:", contract.source.categoryName);
    console.log("Detected subject:", `${contract.productSubject.labelZh} / ${contract.productSubject.labelRu}`);
    console.log("Target model:", contract.targetModel || "-");
    console.log("Material:", contract.material || "-");
    console.log("Color:", contract.color || "-");
    console.log("Quantity:", contract.quantity || "-");
    console.log("Source warnings:", contract.sourceWarnings.length ? contract.sourceWarnings.join(", ") : "none");
    console.log("Existing quality:", JSON.stringify(existingReport, null, 2));
    console.log("Prompt preview:", prompt.slice(0, 2200));

    if (!runAi) continue;

    const startedAt = Date.now();
    try {
      const result = await chatWithAiProvider({
        temperature: 0.2,
        maxTokens: 1800,
        messages: [
          {
            role: "system",
            content: "You are an Ozon Russia automotive listing copy specialist. Return valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      });
      const elapsedMs = Date.now() - startedAt;
      const bundle = parseCopyBundleResponse(result.content);
      const report = validateCopyBundle(bundle, contract);
      console.log("AI provider:", result.provider || "-", result.model || "-", `${elapsedMs}ms`);
      console.log("AI raw:", String(result.content || "").slice(0, 4000));
      console.log("AI parsed:", JSON.stringify(bundle, null, 2));
      console.log("AI quality:", JSON.stringify(report, null, 2));
    } catch (error) {
      console.log("AI error:", error?.message || error);
    }
  }
} finally {
  await closeMysqlPool();
}

function parseArgs(argv = []) {
  const parsed = {
    ids: [],
    targetById: {},
    materialById: {},
    colorById: {},
    quantityById: {},
    noAi: false,
    strategy: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--no-ai") {
      parsed.noAi = true;
    } else if (item === "--ids") {
      parsed.ids = String(argv[index + 1] || "")
        .split(/[,，]/)
        .map((value) => Number(value.trim()))
        .filter(Boolean);
      index += 1;
    } else if (item === "--target") {
      const [id, ...targetParts] = String(argv[index + 1] || "").split(":");
      if (id && targetParts.length) parsed.targetById[id] = targetParts.join(":").trim();
      index += 1;
    } else if (item === "--material") {
      const [id, ...valueParts] = String(argv[index + 1] || "").split(":");
      if (id && valueParts.length) parsed.materialById[id] = valueParts.join(":").trim();
      index += 1;
    } else if (item === "--color") {
      const [id, ...valueParts] = String(argv[index + 1] || "").split(":");
      if (id && valueParts.length) parsed.colorById[id] = valueParts.join(":").trim();
      index += 1;
    } else if (item === "--quantity") {
      const [id, ...valueParts] = String(argv[index + 1] || "").split(":");
      if (id && valueParts.length) parsed.quantityById[id] = valueParts.join(":").trim();
      index += 1;
    } else if (item === "--strategy") {
      parsed.strategy = String(argv[index + 1] || "").trim();
      index += 1;
    }
  }
  return parsed;
}

function printSection(title) {
  console.log("\n" + "=".repeat(20));
  console.log(title);
  console.log("=".repeat(20));
}
