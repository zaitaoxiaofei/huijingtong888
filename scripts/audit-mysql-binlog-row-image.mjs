import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { auditBinlogRowImage } from '../src/services/mysql-binlog-row-image.js';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf('=');
  if (!value.startsWith('--') || at < 3) throw new Error('Use explicit --key=value arguments');
  return [value.slice(2, at), value.slice(at + 1)];
}));
for (const key of Object.keys(args)) if (!['database', 'mysql-admin-socket', 'output'].includes(key)) throw new Error(`Unknown argument: ${key}`);
const socketPath = args['mysql-admin-socket'];
if (!socketPath || !(path.isAbsolute(socketPath) || /^\\\\\.\\pipe\\/.test(socketPath))) throw new Error('An explicit local administrator socket is required; TCP is not supported');
if (!path.isAbsolute(args.output || '')) throw new Error('An absolute output path is required');
const report = await fs.open(path.resolve(args.output), 'wx', 0o600);
let connection;
try {
  // No .env, application credentials, SET, DDL or configuration changes.
  connection = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: false });
  const result = await auditBinlogRowImage(connection, args.database);
  await report.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8');
  await report.sync();
  console.log(JSON.stringify({ ok: result.blocked.length === 0, output: path.resolve(args.output), row_image: result.row_image }));
} finally { await connection?.end(); await report.close(); }
