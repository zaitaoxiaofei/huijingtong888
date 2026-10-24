import { backupAiCreditResults, restoreAiCreditResults, inspectAiCreditResultBackup } from "./lib/ai-credit-result-backup.mjs";
const args = process.argv.slice(2), value = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
if (args.some(arg => !["--restore", "--apply", "--inspect"].includes(arg) && !/^(?:--root|--output|--input)=.+$/.test(arg))) throw new Error("Unknown private result backup argument");
if (new Set(args.map(arg => arg.split("=")[0])).size !== args.length) throw new Error("Duplicate private result backup argument");
if (args.includes("--inspect") && args.includes("--restore") || args.includes("--apply") && !args.includes("--restore")) throw new Error("Conflicting private result backup action");
let report;
if (args.includes("--inspect")) report = await inspectAiCreditResultBackup({ input: value("--input") });
else if (args.includes("--restore")) report = await restoreAiCreditResults({ input: value("--input"), root: value("--root"), apply: args.includes("--apply") });
else {
  if (args.includes("--apply")) throw new Error("--apply is only valid with --restore");
  report = await backupAiCreditResults({ root: value("--root"), output: value("--output") });
}
console.log(JSON.stringify(report));
