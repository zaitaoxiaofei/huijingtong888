import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { calculateOrderProcurementCoverage } from "../src/services/order-procurement-coverage.js";
import { transportStatusesSql } from "../src/services/order-query-facts.js";
import { resolveInventoryTenantScope } from "../src/services/inventory-tenant-scope.js";
import { oglDispatchedStatusSql, oglOnlineStatusSql, oglTerminalStatusSql, oglPhysicalDispatchSql } from "../src/services/ogl-dispatch-state.js";

// Deliberately does not import server.js/mysql-cutover.js or initialize schema.
// Only exact SELECT/EXPLAIN queries pass the execution boundary; no credentials,
// business rows, names, addresses or raw payloads are emitted in this report.
const args = process.argv.slice(2), value = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
if (args.some(arg => arg !== "--explain" && !/^(?:--database|--mysql-admin-socket|--tenant-id|--date-from|--date-to|--compare-coverage-source|--compare-algorithm-source)=.+$/.test(arg))) throw Error("Unknown read-only profile argument");
if (new Set(args.map(arg => arg.split("=")[0])).size !== args.length) throw Error("Duplicate read-only profile argument");
const database = value("--database"), socketPath = value("--mysql-admin-socket"), tenantId = value("--tenant-id");
if (!database || !/^[A-Za-z0-9_]+$/.test(database) || !socketPath || !tenantId) throw Error("Explicit database, administrative socket and tenant ID required");
const pool = mysql.createPool({ database, socketPath, user: "root", connectionLimit: 4, dateStrings: true, timezone: "Z" });
const report = { mode: "read-only", initialization_performed: false, connection_limit: 4, max_select_ms: 10000, measurements: [], assembly: [] };
const plans = [];
let snapshot, serial = Promise.resolve(), variant = "baseline";
const digest = sql => createHash("sha256").update(sql).digest("hex");
const label = sql => sql.startsWith("SELECT o.id AS order_id") ? "procurement_demands"
  : sql.includes("AS all_count") ? "status_counts" : sql.includes("FROM inventory_movements") ? "inventory_movements"
    : sql.includes("FROM inbound_records") ? "inbound_records" : sql.includes("FROM procurement_order_allocations") ? "procurement_allocations"
      : sql.includes("FROM procurement_requests") ? "procurement_requests" : sql.includes("FROM products WHERE") ? "owned_products" : "other_scoped_read";
async function query(sql, params = []) {
  sql = sql.trim();
  if (!/^(?:SELECT|EXPLAIN FORMAT=JSON SELECT)\s/i.test(sql) || /;|\b(?:INTO|FOR UPDATE|LOCK IN SHARE MODE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b/i.test(sql)) throw Error("Non-read-only SQL refused by profiler");
  if (snapshot) {
    const result = serial.then(() => executeRead(sql, params, snapshot));
    serial = result.catch(() => {}); return result;
  }
  return executeRead(sql, params);
}
async function executeRead(sql, params, fixedConnection) {
  const waited = performance.now(), connection = fixedConnection || await pool.getConnection();
  try {
    if (!fixedConnection) {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
      await connection.query("SET SESSION max_execution_time = 10000");
    }
    const started = performance.now(), [rows] = await connection.query(sql, params);
    report.measurements.push({ variant, stage: label(sql), sql_sha256: digest(sql), sql_bytes: Buffer.byteLength(sql), rows: rows.length,
      pool_wait_ms: +(started - waited).toFixed(2), query_ms: +(performance.now() - started).toFixed(2) });
    if (args.includes("--explain") && (sql.startsWith("SELECT o.id AS order_id") || sql.includes("AS all_count"))) plans.push({ sql, params, variant });
    return rows;
  } finally { if (!fixedConnection) connection.release(); }
}
function coverageHash(coverage) {
  function stable(value) {
    if (Object.prototype.toString.call(value) === "[object Map]") return [...value].map(([key, item]) => [key, stable(item)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (Object.prototype.toString.call(value) === "[object Date]") return value.toJSON();
    if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  }
  return digest(JSON.stringify({ orders: stable(coverage), properties: stable({ ...coverage }) }));
}
function algorithmReader(source) {
  if (/^import\s/m.test(source)) throw Error("Pure allocation profile source must not import runtime services");
  const context = vm.createContext({ Date });
  vm.runInContext(source.replace(/^export /gm, ""), context);
  if (typeof context.calculateOrderProcurementCoverage !== "function") throw Error("Pure allocation function missing from profile source");
  return context.calculateOrderProcurementCoverage;
}
function coverageReader(source, algorithm = calculateOrderProcurementCoverage) {
  let started, inputsReady, prepared, algorithmMs = 0, inputRows;
  const profileMark = name => { if (name === "inputs") inputsReady = performance.now(); else prepared = performance.now(); };
  const calculate = input => {
    inputRows = Object.fromEntries(Object.entries(input).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    const before = performance.now();
    try { return algorithm(input); }
    finally { algorithmMs += performance.now() - before; }
  };
  const context = vm.createContext({ calculateOrderProcurementCoverage: calculate, transportStatusesSql, oglPhysicalDispatchSql, resolveInventoryTenantScope,
    __profileCoveragePhase: profileMark,
    loadFbpReservations: () => { throw Error("Unexpected global FBP access refused by read-only profiler"); } });
  const code = source.replace(/^import[^\n]*\r?\n/gm, "").replace(/^export /gm, "")
    .replace("const liveItems =", "__profileCoveragePhase('inputs'); const liveItems =")
    .replace("const value = calculateOrderProcurementCoverage(", "__profileCoveragePhase('prepared'); const value = calculateOrderProcurementCoverage(");
  vm.runInContext(code, context);
  const original = context.loadOrderProcurementCoverage;
  context.loadOrderProcurementCoverage = async (...args) => {
    started = performance.now();
    const result = await original(...args), finished = performance.now();
    report.assembly.push({ variant, input_rows: inputRows, inputs_ms: +((inputsReady || finished) - started).toFixed(2),
      prepare_ms: +((prepared || finished) - (inputsReady || finished)).toFixed(2), algorithm_ms: +algorithmMs.toFixed(2),
      finalize_ms: +(finished - (prepared || finished) - algorithmMs).toFixed(2) });
    return result;
  };
  return context;
}
function planTables(plan) {
  const rows = [];
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.table_name) rows.push(Object.fromEntries(["table_name", "access_type", "key", "rows_examined_per_scan", "rows_produced_per_join", "filtered"].filter(key => key in value).map(key => [key, value[key]])));
    for (const child of Object.values(value)) if (typeof child === "object") walk(child);
  }
  walk(plan); return rows;
}
function boundary(value, next = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw Error("Explicit Beijing YYYY-MM-DD date range required");
  const date = new Date(value + "T00:00:00+08:00");
  if (!Number.isFinite(date.getTime())) throw Error("Invalid date boundary");
  if (next) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 19).replace("T", " ");
}
try {
  const comparing = Boolean(value("--compare-coverage-source") || value("--compare-algorithm-source"));
  if (comparing) {
    snapshot = await pool.getConnection();
    await snapshot.query("SET SESSION max_execution_time = 10000");
    await snapshot.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    report.connection_limit = 1; report.consistent_read_only_snapshot = true;
  }
  const scope = await resolveInventoryTenantScope(tenantId, query);
  const ownerScope = { id: scope.id, defaultTenant: scope.isDefault };
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const coverageSource = await readFile(new URL("../src/services/mysql-order-procurement-coverage.js", import.meta.url), "utf8");
  const algorithmSource = value("--compare-algorithm-source") ? await readFile(new URL("../src/services/order-procurement-coverage.js", import.meta.url), "utf8") : null;
  const coverageContext = coverageReader(coverageSource, algorithmSource ? algorithmReader(algorithmSource) : calculateOrderProcurementCoverage);
  const names = ["orderTenantPredicateMysql", "orderStatusSqlMysql", "orderPagedOglEvidenceJoinMysql", "orderPagedUnboundEvidenceJoinMysql", "orderPagedSqlCountsMysql"];
  const definitions = names.map(name => {
    const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, "m"));
    if (!match) throw Error("Checked-in order count function is missing");
    return match[0].replace(/^export /, "");
  });
  const context = vm.createContext({ Number, String, Object, Array, Math, procurementQueueSql: coverageContext.procurementQueueSql,
    oglDispatchedStatusSql, oglOnlineStatusSql, oglTerminalStatusSql, mysqlQueryOne: async (sql, params) => (await query(sql, params))[0] });
  vm.runInContext(definitions.join("\n"), context);
  const started = performance.now();
  const coverage = await coverageContext.loadOrderProcurementCoverage(query, "", { tenantId: scope.id, fresh: true });
  report.coverage_total_ms = +(performance.now() - started).toFixed(2);
  report.coverage_orders = coverage.size;
  report.coverage_sha256 = coverageHash(coverage);
  const base = { where: `EXISTS (SELECT 1 FROM shops tenant_shop WHERE tenant_shop.id=o.shop_id AND ${context.orderTenantPredicateMysql("tenant_shop", ownerScope)}) AND o.ordered_at >= ? AND o.ordered_at < ?`,
    params: [boundary(value("--date-from")), boundary(value("--date-to"), true)] };
  const counted = performance.now(); report.counts = await context.orderPagedSqlCountsMysql(base, coverage, ownerScope);
  report.count_sql_ms = +(performance.now() - counted).toFixed(2);
  report.total_ms = +(performance.now() - started).toFixed(2);
  if (comparing) {
    variant = "candidate";
    const candidateSource = value("--compare-coverage-source") ? await readFile(value("--compare-coverage-source"), "utf8") : coverageSource;
    const candidateAlgorithmSource = value("--compare-algorithm-source") ? await readFile(value("--compare-algorithm-source"), "utf8") : null;
    const candidate = coverageReader(candidateSource, candidateAlgorithmSource ? algorithmReader(candidateAlgorithmSource) : calculateOrderProcurementCoverage);
    const newer = performance.now(), candidateCoverage = await candidate.loadOrderProcurementCoverage(query, "", { tenantId: scope.id, fresh: true });
    const coverageMs = +(performance.now() - newer).toFixed(2), hash = coverageHash(candidateCoverage);
    const countStart = performance.now(), counts = await context.orderPagedSqlCountsMysql(base, candidateCoverage, ownerScope);
    report.comparison = { baseline_sha256: report.coverage_sha256, candidate_sha256: hash, equal_coverage: hash === report.coverage_sha256,
      candidate_orders: candidateCoverage.size, candidate_coverage_ms: coverageMs, candidate_counts_ms: +(performance.now() - countStart).toFixed(2),
      equal_counts: JSON.stringify(counts) === JSON.stringify(report.counts),
      ...(algorithmSource ? { baseline_algorithm_sha256: digest(algorithmSource), candidate_algorithm_sha256: digest(candidateAlgorithmSource) } : {}) };
  }
  report.explains = [];
  for (const { sql, params, variant: plannedVariant } of [...plans]) {
    const [row] = await query(`EXPLAIN FORMAT=JSON ${sql}`, params);
    report.explains.push({ variant: plannedVariant, sql_sha256: digest(sql), tables: planTables(JSON.parse(row.EXPLAIN)) });
  }
  console.log(JSON.stringify(report, null, 2));
} finally { if (snapshot) { await snapshot.rollback(); snapshot.release(); } await pool.end(); }
