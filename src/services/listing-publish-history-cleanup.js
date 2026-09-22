import { mysqlExecute } from "../mysql-pool.js";

async function deleteInBatches(sql, params, batchSize) {
  let deleted = 0;
  for (;;) {
    const result = await mysqlExecute(sql.replace("/* batch */", String(batchSize)), params);
    const affected = Number(result?.affectedRows || 0);
    deleted += affected;
    if (affected < batchSize) return deleted;
  }
}

export async function cleanupListingPublishHistory(options = {}) {
  const taskRetentionDays = Math.max(1, Math.min(90, Number(options.taskRetentionDays || options.task_retention_days || 7) || 7));
  const recordRetentionDays = Math.max(1, Math.min(365, Number(options.recordRetentionDays || options.record_retention_days || 30) || 30));
  const batchSize = Math.max(100, Math.min(5000, Number(options.batchSize || options.batch_size || 500) || 500));
  const orphanTemplateRetentionDays = Math.max(1, Math.min(90, Number(options.orphanTemplateRetentionDays || options.orphan_template_retention_days || 7) || 7));

  const taskItemsDeleted = await deleteInBatches(`
    DELETE FROM listing_publish_task_items
    WHERE id IN (
      SELECT id FROM (
        SELECT i.id
        FROM listing_publish_task_items i
        JOIN listing_publish_tasks t ON t.id = i.publish_task_id
        WHERE t.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        ORDER BY i.id
        LIMIT /* batch */
      ) expired
    )
  `, [taskRetentionDays], batchSize);
  const tasksDeleted = await deleteInBatches(`
    DELETE FROM listing_publish_tasks
    WHERE id IN (
      SELECT id FROM (
        SELECT id FROM listing_publish_tasks
        WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        ORDER BY id
        LIMIT /* batch */
      ) expired
    )
  `, [taskRetentionDays], batchSize);
  const recordsDeleted = await deleteInBatches(`
    DELETE FROM listing_publish_records
    WHERE id IN (
      SELECT id FROM (
        SELECT r.id
        FROM listing_publish_records r
        WHERE r.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
          AND NOT EXISTS (
            SELECT 1 FROM listing_publish_task_items i WHERE i.record_id = r.id
          )
        ORDER BY r.id
        LIMIT /* batch */
      ) expired
    )
  `, [recordRetentionDays], batchSize);
  const orphanTemplatesDeleted = await deleteInBatches(`
    DELETE FROM listing_category_templates
    WHERE id IN (
      SELECT id FROM (
        SELECT t.id
        FROM listing_category_templates t
        WHERE t.source_type = 'ai_optimization_v2_lightweight'
          AND t.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
          AND NOT EXISTS (SELECT 1 FROM listing_drafts d WHERE d.template_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM listing_ai_variant_assets a WHERE a.listing_template_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM listing_collected_product_details c WHERE c.template_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM listing_media_assets m WHERE m.template_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM listing_ozon_copy_jobs j WHERE j.template_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM ozon_plugin_collected_products p WHERE p.listing_template_id = t.id)
        ORDER BY t.id
        LIMIT /* batch */
      ) expired
    )
  `, [orphanTemplateRetentionDays], batchSize);

  return {
    ok: true,
    taskRetentionDays,
    recordRetentionDays,
    orphanTemplateRetentionDays,
    taskItemsDeleted,
    tasksDeleted,
    recordsDeleted,
    orphanTemplatesDeleted
  };
}
