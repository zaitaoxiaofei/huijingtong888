import mysql from "mysql2/promise";
import { config } from "./config.js";

let mysqlPool = null;
const MYSQL_SESSION_TIME_ZONE = "+00:00";

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
      reject(createMysqlBusyError("数据库连接等待超时，请稍后重试"));
    }, timeoutMs);
  });

  try {
    const connection = await Promise.race([acquirePromise, timeoutPromise]);
    if (!connection) throw createMysqlBusyError("数据库连接等待超时，请稍后重试");
    return connection;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureMysqlSessionUtc(connection) {
  await connection.query("SET time_zone = ?", [MYSQL_SESSION_TIME_ZONE]);
}

export async function mysqlQuery(sql, params = []) {
  const connection = await getMysqlConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    const [rows] = await connection.query(sql, params);
    return rows;
  } finally {
    connection.release();
  }
}

export async function mysqlExecute(sql, params = []) {
  const connection = await getMysqlConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    const [result] = await connection.execute(sql, params);
    return result;
  } finally {
    connection.release();
  }
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
    connection.release();
  }
}
