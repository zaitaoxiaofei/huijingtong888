import mysql from "mysql2/promise";

import { config } from "../src/config.js";

export async function createMysqlConnection(options = {}) {
  const {
    host = config.dbHost,
    port = config.dbPort,
    user = config.dbUser,
    password = config.dbPassword,
    database = config.dbName,
    multipleStatements = true
  } = options;

  if (!host || !user || !database) {
    throw new Error("MySQL connection requires DB_HOST, DB_USER, and DB_NAME");
  }

  return mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    multipleStatements,
    charset: "utf8mb4"
  });
}

export async function closeMysqlConnection(connection) {
  if (!connection) return;
  await connection.end();
}
