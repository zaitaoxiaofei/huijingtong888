import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";

const db = new DatabaseSync(config.databasePath);

try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("PRAGMA optimize;");
  console.log(`Checkpoint completed: ${config.databasePath}`);
} finally {
  db.close();
}
