// Frozen row-at-a-time initializer/writers from release b1880bd. Evaluated in
// the isolated catalog VM; free names deliberately resolve to that VM's inputs.
export async function legacyInitializeVehicleCatalogSchema() {
  await withMysqlTransaction(connection => migrateAiVehicleCatalogSchema(connection, { apply: true }));
  await ensureCatalogMetadataColumns();
  for (const [baseTag, groups] of [["hot_new", NEW_VEHICLES], ["hot_used", USED_VEHICLES]]) {
    for (const [brand, models] of groups) {
      const brandTags = unique(["hot_all", baseTag, PRIORITY_BRANDS.has(brand) ? "priority_brand" : ""].filter(Boolean));
      await seedRow(brand, "", brandTags);
      for (const model of models) {
        const fullName = `${brand} ${model}`.toUpperCase();
        const modelTags = unique([
          ...brandTags,
          TOP_MODELS.has(fullName) ? "top_priority_model" : "",
          HOT_NEW_ENERGY_MODELS.has(fullName) ? "hot_new_energy" : ""
        ].filter(Boolean));
        await seedRow(brand, model, modelTags);
      }
    }
  }
  for (const [brand, model, aliases, supplyAnchor, searchKeywords, recommendedProducts, competition, priority] of RUSSIA_CHINA_VEHICLE_ANCHORS) {
    const priorityTags = /^S/i.test(priority) ? ["top_priority_model"] : [];
    await seedRow(brand, "", ["hot_all", "hot_new", "priority_brand"]);
    await seedAnchoredRow(brand, model, ["hot_all", "hot_new", "priority_brand", ...priorityTags], {
      aliases, supplyAnchor, searchKeywords, recommendedProducts, competition, priority
    });
  }
  schemaReady = true;
}

export async function legacySeedRow(brand, model, tags) {
  await mysqlExecute(`
    INSERT INTO ai_vehicle_catalog
      (brand_key, brand_name, model_key, model_name, tags_json, source, tenant_id)
    VALUES (?, ?, ?, ?, ?, 'builtin', 'builtin')
    ON DUPLICATE KEY UPDATE
      tags_json = IF(source = 'builtin', VALUES(tags_json), tags_json),
      updated_at = CURRENT_TIMESTAMP
  `, [keyOf(brand), brand, model ? keyOf(model) : "__brand__", model, JSON.stringify(tags)]);
}

export async function legacySeedAnchoredRow(brand, model, tags, metadata) {
  await mysqlExecute(`
    INSERT INTO ai_vehicle_catalog
      (brand_key, brand_name, model_key, model_name, tags_json, aliases_json, supply_anchor,
       search_keywords_json, recommended_products_json, ozon_competition, user_priority, source, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', 'builtin')
    ON DUPLICATE KEY UPDATE
      tags_json = IF(source = 'builtin', VALUES(tags_json), tags_json),
      aliases_json = VALUES(aliases_json), supply_anchor = VALUES(supply_anchor),
      search_keywords_json = VALUES(search_keywords_json), recommended_products_json = VALUES(recommended_products_json),
      ozon_competition = VALUES(ozon_competition), user_priority = VALUES(user_priority), updated_at = CURRENT_TIMESTAMP
  `, [keyOf(brand), brand, keyOf(model), model, JSON.stringify(tags), JSON.stringify(metadata.aliases), metadata.supplyAnchor,
    JSON.stringify(metadata.searchKeywords), JSON.stringify(metadata.recommendedProducts), metadata.competition, metadata.priority]);
}
