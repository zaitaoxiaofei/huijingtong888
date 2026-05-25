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
      queueLimit: 0,
      multipleStatements: false
    });
  }
  return mysqlPool;
}

async function ensureMysqlSessionUtc(connection) {
  await connection.query("SET time_zone = ?", [MYSQL_SESSION_TIME_ZONE]);
}

export async function mysqlQuery(sql, params = []) {
  const connection = await getMysqlPool().getConnection();
  try {
    await ensureMysqlSessionUtc(connection);
    const [rows] = await connection.query(sql, params);
    return rows;
  } finally {
    connection.release();
  }
}

export async function mysqlExecute(sql, params = []) {
  const connection = await getMysqlPool().getConnection();
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
  const connection = await getMysqlPool().getConnection();
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
