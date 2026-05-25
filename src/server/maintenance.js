import { config } from "../config.js";

export function systemInfo() {
  return {
    host: config.host || "",
    port: config.port,
    dbClient: config.dbClient,
    database: {
      host: config.dbHost,
      port: config.dbPort,
      name: config.dbName,
      user: config.dbUser
    },
    appBaseUrl: config.appBaseUrl
  };
}
