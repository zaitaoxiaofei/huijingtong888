const DATABASE_NAME = /^[a-zA-Z0-9_]+$/;

export async function auditBinlogRowImage(connection, database) {
  if (!DATABASE_NAME.test(database || '')) throw new Error('An explicit database name is required');
  const [[server]] = await connection.query(`SELECT @@server_uuid server_uuid, @@version version,
    @@global.log_bin log_bin, @@global.binlog_format binlog_format, @@global.binlog_row_image row_image`);
  const [persisted] = await connection.query("SELECT VARIABLE_VALUE value FROM performance_schema.persisted_variables WHERE VARIABLE_NAME = 'binlog_row_image'");
  const [replicas] = await connection.query('SHOW REPLICAS');
  const [sources] = await connection.query('SHOW REPLICA STATUS');
  const [tables] = await connection.execute(`SELECT t.table_name name,
    EXISTS (SELECT 1 FROM information_schema.statistics s WHERE s.table_schema = t.table_schema
      AND s.table_name = t.table_name AND s.index_name = 'PRIMARY') has_primary_key
    FROM information_schema.tables t WHERE t.table_schema = ? AND t.table_type = 'BASE TABLE' ORDER BY t.table_name`, [database]);
  const blocked = [];
  if (!/^8\./.test(server.version)) blocked.push('Requires reviewed MySQL 8.x behavior');
  if (!Number(server.log_bin) || server.binlog_format !== 'ROW') blocked.push('Requires enabled ROW binary logging');
  if (replicas.length || sources.length) blocked.push('Replication topology requires a separate review');
  if (!tables.length) blocked.push('Database must exist and contain application tables');
  return {
    format: 'ozon-binlog-row-image-audit-v1', database, ...server,
    persisted_image: persisted[0]?.value ?? null,
    target_image: 'NOBLOB', table_count: tables.length,
    tables_without_primary_key: tables.filter(row => !Number(row.has_primary_key)).map(row => row.name),
    replica_count: replicas.length, source_count: sources.length, blocked
  };
}
