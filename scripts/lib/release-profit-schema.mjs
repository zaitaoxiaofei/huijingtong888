import { ORDER_PROFIT_CALCULATION_SCHEMA } from "../../src/services/order-profit-calculation-schema.js";

const normalizeType = value => String(value).trim().toLowerCase().replace(/\s+/g, " ")
  .replace(/^(bigint|int|tinyint)\(\d+\)/, "$1");
const field = (row, name) => row[name] ?? row[name.toLowerCase()];

function canonicalTables() {
  return ORDER_PROFIT_CALCULATION_SCHEMA.map(sql => {
    const name = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql.trim())?.[1];
    if (!name) throw new Error("Unsupported canonical profit table definition");
    const columns = new Map(), indexes = new Map();
    const index = (key, names, unique) => {
      const parts = names.split(",").map(value => value.trim());
      if (parts.some(value => !/^\w+$/.test(value))) throw new Error("Unsupported canonical profit index definition");
      indexes.set(key, { columns: parts, unique });
    };
    for (const line of sql.split("\n").slice(1)) {
      const primary = /^\s*PRIMARY KEY\s*\(([^)]+)\)/i.exec(line);
      const secondary = /^\s*(UNIQUE\s+)?KEY\s+(\w+)\s*\(([^)]+)\)/i.exec(line);
      if (primary) { index("PRIMARY", primary[1], true); continue; }
      if (secondary) { index(secondary[2], secondary[3], Boolean(secondary[1])); continue; }
      if (/^\s*\)/.test(line)) continue;
      const column = /^\s+(\w+)\s+((?:BIGINT|INT|TINYINT)(?:\(\d+\))?(?: UNSIGNED)?|(?:VARCHAR|CHAR)\(\d+\)|LONGTEXT|DATETIME(?:\(\d+\))?)(?=\s|,|$)(.*)$/i.exec(line);
      if (!column) throw new Error("Unsupported canonical profit column definition");
      const [, columnName, type, suffix] = column;
      columns.set(columnName, { type: normalizeType(type),
        nullable: !/\bNOT NULL\b|\bPRIMARY KEY\b/i.test(suffix),
        autoIncrement: /\bAUTO_INCREMENT\b/i.test(suffix) });
      if (/\bPRIMARY KEY\b/i.test(suffix)) index("PRIMARY", columnName, true);
    }
    return { name, columns, indexes };
  });
}

const expectedTables = canonicalTables();
function incompatible(table, reason) {
  throw Object.assign(new Error(`Existing profit calculation schema is incompatible: ${table}: ${reason}`), {
    code: "RELEASE_PROFIT_SCHEMA_INCOMPATIBLE"
  });
}

export async function inspectReleaseProfitSchema(query) {
  const tables = await query(`SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${expectedTables.map(() => "?").join(",")})`, expectedTables.map(table => table.name));
  const missing = [];
  for (const expected of expectedTables) {
    const table = tables.find(row => field(row, "TABLE_NAME") === expected.name);
    if (!table) { missing.push(expected.name); continue; }
    if (String(field(table, "ENGINE")).toUpperCase() !== "INNODB") incompatible(expected.name, "engine must be InnoDB");
    const columns = await query(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [expected.name]);
    for (const [name, definition] of expected.columns) {
      const actual = columns.find(row => field(row, "COLUMN_NAME") === name);
      if (!actual || normalizeType(field(actual, "COLUMN_TYPE")) !== definition.type
        || field(actual, "IS_NULLABLE") !== (definition.nullable ? "YES" : "NO")) incompatible(expected.name, `column ${name}`);
      const extra = String(field(actual, "EXTRA") || "");
      if (/auto_increment/i.test(extra) !== definition.autoIncrement
        || /(?:VIRTUAL|STORED) GENERATED|INVISIBLE|on update/i.test(extra)) incompatible(expected.name, `automatic column behavior ${name}`);
    }
    const indexes = await query(`SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX,
      SUB_PART, EXPRESSION, IS_VISIBLE, INDEX_TYPE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [expected.name]);
    for (const [name, definition] of expected.indexes) {
      const parts = indexes.filter(row => field(row, "INDEX_NAME") === name)
        .sort((left, right) => Number(field(left, "SEQ_IN_INDEX")) - Number(field(right, "SEQ_IN_INDEX")));
      if (parts.length !== definition.columns.length || parts.some((part, ordinal) =>
        field(part, "COLUMN_NAME") !== definition.columns[ordinal]
        || Number(field(part, "NON_UNIQUE")) !== Number(!definition.unique)
        || field(part, "SUB_PART") != null || field(part, "EXPRESSION") != null
        || field(part, "IS_VISIBLE") !== "YES" || String(field(part, "INDEX_TYPE")).toUpperCase() !== "BTREE")) {
        incompatible(expected.name, `index ${name}`);
      }
    }
    if (indexes.some(row => Number(field(row, "NON_UNIQUE")) === 0 && !expected.indexes.has(field(row, "INDEX_NAME")))) {
      incompatible(expected.name, "unexpected unique index");
    }
  }
  return { missing_tables: missing };
}
