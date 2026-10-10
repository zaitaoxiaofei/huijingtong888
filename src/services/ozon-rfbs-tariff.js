import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL("../../data/ozon-rfbs-tariffs/", import.meta.url));
const cache = new Map();

export async function latestRfbsTariff(now = new Date()) {
  const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}-[a-f0-9]{12}\.json$/.test(name)).sort().reverse();
  const today = now.toISOString().slice(0, 10);
  const eligible = names.filter((name) => name.slice(0, 10) <= today);
  if (!eligible.length) throw new Error("没有已生效的 Ozon rFBS 佣金表，请导入最新版官方表格");
  const sameDate = eligible.filter((name) => name.slice(0, 10) === eligible[0].slice(0, 10));
  let latest = null;
  for (const name of sameDate) {
    const filename = path.join(directory, name);
    const modified = (await stat(filename)).mtimeMs;
    const cached = cache.get(filename);
    const payload = cached?.modified === modified ? cached.payload : JSON.parse(await readFile(filename, "utf8"));
    cache.set(filename, { modified, payload });
    if (!latest || payload.importedAt > latest.importedAt) latest = payload;
  }
  return latest;
}

export function searchRfbsCategories(tariff, keyword = "", limit = 50) {
  const query = String(keyword).trim().toLocaleLowerCase();
  const rows = tariff.rows.flatMap((row, index) => {
    const label = `${row[2]} / ${row[1]} / ${row[0]}${row[6] === "All" ? "" : ` / ${row[6]}`}`;
    const searchable = `${label} ${row[3]} ${row[4]} ${row[5]}`.toLocaleLowerCase();
    return !query || searchable.includes(query) ? [{ id: index, label, brand: row[6], rates: row.slice(7, 10) }] : [];
  });
  return { version: tariff.effectiveDate, sourceFile: tariff.sourceFile, total: rows.length, rows: rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 100))) };
}

export function rfbsCategory(tariff, index) {
  if (index === null || index === undefined || String(index).trim() === "") return null;
  const row = tariff.rows[Number(index)];
  if (!row || !Number.isInteger(Number(index))) return null;
  return { id: Number(index), label: `${row[2]} / ${row[1]} / ${row[0]}${row[6] === "All" ? "" : ` / ${row[6]}`}`, brand: row[6], rates: row.slice(7, 10), version: tariff.effectiveDate, sourceFile: tariff.sourceFile };
}
