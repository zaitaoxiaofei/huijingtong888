import mysql from "mysql2/promise";
import { config } from "./config.js";

let mysqlPool = null;
const MYSQL_SESSION_TIME_ZONE = "+00:00";
const initializedMysqlSessions = new WeakSet();
const mysqlPoolMetrics = {
  activeConnections: 0,
  peakActiveConnections: 0,
  acquisitions: 0,
  acquireWaitMsTotal: 0,
  lastAcquireWaitMs: 0,
  slowAcquisitions: 0,
  acquireTimeouts: 0
};
const MYSQL_SLOW_ACQUIRE_MS = Math.max(50, Number(process.env.DB_POOL_SLOW_ACQUIRE_MS || 250));

export function isMysqlPrimaryEnabled() {
  return String(config.dbClient || "").toLowerCase() === "mysql";
}

export function getMysqlPool() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL primary mode is not enabled");
  }
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPassword,
      database: config.dbName,
      charset: "utf8mb4",
      timezone: "Z",
      waitForConnections: true,
      connectionLimit: Math.max(1, Number(config.dbPoolMax || 10)),
      maxIdle: Math.max(1, Number(config.dbPoolMax || 10)),
      idleTimeout: 60000,
      queueLimit: Math.max(0, Number(config.dbPoolQueueLimit ?? 100)),
      multipleStatements: false
    });
  }
  return mysqlPool;
}

function createMysqlBusyError(message, cause) {
  const error = new Error(message || "系统繁忙，请稍后重试");
  error.status = 503;
  error.code = "DB_POOL_BUSY";
  if (cause) error.cause = cause;
  return error;
}

function normalizeMysqlAcquireError(error) {
  const code = String(error?.code || "");
  if (code === "POOL_ENQUEUELIMIT") {
    return createMysqlBusyError("系统繁忙，请稍后重试", error);
  }
  return error;
}

async function getMysqlConnection() {
  const pool = getMysqlPool();
  const timeoutMs = Math.max(1000, Number(config.dbPoolAcquireTimeoutMs || 10000));
  const startedAt = performance.now();
  let timedOut = false;
  let timeoutId = null;

  const acquirePromise = pool.getConnection().then((connection) => {
    if (timedOut) {
      connection.release();
      return null;
    }
    return connection;
  }).catch((error) => {
    if (timedOut) return null;
    throw normalizeMysqlAcquireError(error);
  });

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      mysqlPoolMetrics.acquireTimeouts += 1;
      reject(createMysqlBusyError("数据库连接等待超时，请稍后重试"));
    }, timeoutMs);
  });

  try {
    const connection = await Promise.race([acquirePromise, timeoutPromise]);
    if (!connection) throw createMysqlBusyError("数据库连接等待超时，请稍后重试");
    const waitMs = Math.max(0, performance.now() - startedAt);
    mysqlPoolMetrics.acquisitions += 1;
    mysqlPoolMetrics.acquireWaitMsTotal += waitMs;
    mysqlPoolMetrics.lastAcquireWaitMs = waitMs;
    mysqlPoolMetrics.activeConnections += 1;
    mysqlPoolMetrics.peakActiveConnections = Math.max(mysqlPoolMetrics.peakActiveConnections, mysqlPoolMetrics.activeConnections);
    if (waitMs >= MYSQL_SLOW_ACQUIRE_MS) {
      mysqlPoolMetrics.slowAcquisitions += 1;
      console.warn(`[mysql-pool] slow acquire wait=${waitMs.toFixed(1)}ms active=${mysqlPoolMetrics.activeConnections} limit=${config.dbPoolMax || 10}`);
    }
    return connection;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function releaseMysqlConnection(connection) {
  mysqlPoolMetrics.activeConnections = Math.max(0, mysqlPoolMetrics.activeConnections - 1);
  connection.release();
}

export function getMysqlPoolMetrics() {
  const acquisitions = Number(mysqlPoolMetrics.acquisitions || 0);
  return {
    ...mysqlPoolMetrics,
    connectionLimit: Math.max(1, Number(config.dbPoolMax || 10)),
    averageAcquireWaitMs: acquisitions ? mysqlPoolMetrics.acquireWaitMsTotal / acquisitions : 0
  };
}

export async function warmMysqlPool() {
  const connectionCount = Math.max(1, Math.min(
    Number(config.dbPoolMin || 0) || 2,
    Number(config.dbPoolMax || 10)
  ));
  await Promise.all(Array.from({ length: connectionCount }, async () => {
    const connection = await getMysqlConnection();
    try {
      await ensureMysqlSessionUtc(connection);
      await connection.query("SELECT 1 AS ready");
    } finally {
      releaseMysqlConnection(connection);
    }
  }));
  return getMysqlPoolMetrics();
}

async function ensureMysqlSessionUtc(connection) {
  if (initializedMysqlSessions.has(connection)) return;
  await connection.query("SET time_zone = ?", [MYSQL_SESSION_TIME_ZONE]);
  initializedMysqlSessions.add(connection);
}

export async function mysqlQuery(sql, params = []) {
  const connection = await getMysqlConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    const [rows] = await connection.query(sql, params);
    return rows;
  } finally {
    releaseMysqlConnection(connection);
  }
}

export async function mysqlExecute(sql, params = []) {
  const connection = await getMysqlConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    return await executeMysqlStatementWithRetry(connection, sql, params);
  } finally {
    releaseMysqlConnection(connection);
  }
}

export async function executeMysqlStatementWithRetry(connection, sql, params = [], options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const [result] = await connection.execute(sql, params);
      return result;
    } catch (error) {
      if (error?.code !== "ER_LOCK_DEADLOCK" || attempt >= maxAttempts) throw error;
      await sleepImpl(attempt * 100);
    }
  }
  throw new Error("MySQL statement retry exhausted");
}

export async function closeMysqlPool() {
  if (!mysqlPool) return;
  const pool = mysqlPool;
  mysqlPool = null;
  await pool.end();
}

export async function withMysqlTransaction(callback) {
  const connection = await getMysqlConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    releaseMysqlConnection(connection);
  }
}
