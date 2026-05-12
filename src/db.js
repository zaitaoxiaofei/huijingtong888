import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      legal_entity TEXT,
      ozon_client_id TEXT,
      api_key_hint TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      payout_rate REAL NOT NULL DEFAULT 0.33,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'operator',
      avatar_url TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      selection_id TEXT UNIQUE,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      image_url TEXT,
      purchase_url TEXT,
      supplier_note TEXT,
      source_platform TEXT NOT NULL DEFAULT '1688',
      shipping_method TEXT NOT NULL DEFAULT 'air_land',
      recommended_shipping_method TEXT NOT NULL DEFAULT 'air_land',
      purchase_cost REAL NOT NULL DEFAULT 0,
      domestic_shipping REAL NOT NULL DEFAULT 0,
      handling_fee REAL NOT NULL DEFAULT 0,
      purchase_quantity INTEGER NOT NULL DEFAULT 1,
      package_weight_g REAL NOT NULL DEFAULT 0,
      length_cm REAL NOT NULL DEFAULT 30,
      width_cm REAL NOT NULL DEFAULT 20,
      height_cm REAL NOT NULL DEFAULT 10,
      listing_price_rub REAL NOT NULL DEFAULT 0,
      air_sale_price_rmb REAL NOT NULL DEFAULT 0,
      exchange_rate REAL NOT NULL DEFAULT 11.32,
      target_margin REAL NOT NULL DEFAULT 0.2,
      desired_profit_mode TEXT NOT NULL DEFAULT 'margin',
      desired_profit_value REAL NOT NULL DEFAULT 20,
      return_rate REAL NOT NULL DEFAULT 0.05,
      payment_fee_rate REAL NOT NULL DEFAULT 0.013,
      withdrawal_fee_rate REAL NOT NULL DEFAULT 0.012,
      owner_person_id INTEGER REFERENCES people(id),
      created_by_person_id INTEGER REFERENCES people(id),
      product_type TEXT NOT NULL DEFAULT 'main',
      parent_product_id INTEGER REFERENCES products(id),
      accessory_note TEXT,
      selection_status TEXT NOT NULL DEFAULT 'draft',
      alert_stock INTEGER NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS online_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      ozon_sku TEXT NOT NULL,
      offer_id TEXT,
      name TEXT NOT NULL,
      image_url TEXT,
      primary_image TEXT,
      sale_price REAL NOT NULL DEFAULT 0,
      currency_code TEXT,
      marketing_price REAL NOT NULL DEFAULT 0,
      old_price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online',
      visibility TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      is_discounted INTEGER NOT NULL DEFAULT 0,
      images_json TEXT,
      barcodes_json TEXT,
      stocks_json TEXT,
      commissions_json TEXT,
      attributes_json TEXT,
      raw_json TEXT,
      ozon_updated_at TEXT,
      product_id INTEGER REFERENCES products(id),
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, ozon_sku)
    );

    CREATE TABLE IF NOT EXISTS sku_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      person_id INTEGER REFERENCES people(id),
      online_product_id INTEGER REFERENCES online_products(id),
      ozon_sku TEXT NOT NULL,
      offer_id TEXT,
      display_name TEXT,
      commission_low REAL NOT NULL DEFAULT 0.12,
      commission_high REAL NOT NULL DEFAULT 0.17,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, ozon_sku)
    );

    CREATE TABLE IF NOT EXISTS procurement_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      person_id INTEGER REFERENCES people(id),
      quantity INTEGER NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      shipping_amount REAL NOT NULL DEFAULT 0,
        purchase_url TEXT,
        source_type TEXT NOT NULL DEFAULT '1688',
        supplier_id INTEGER REFERENCES suppliers(id),
        approval_status TEXT NOT NULL DEFAULT 'draft',
      status TEXT NOT NULL DEFAULT 'pending',
      needed_by TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inbound_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      person_id INTEGER REFERENCES people(id),
      quantity INTEGER NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      shipping_amount REAL NOT NULL DEFAULT 0,
      purchase_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending_arrival',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS outbound_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      shop_id INTEGER REFERENCES shops(id),
      online_product_id INTEGER REFERENCES online_products(id),
      order_ref TEXT,
      person_id INTEGER REFERENCES people(id),
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'order',
      status TEXT NOT NULL DEFAULT 'deducted',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      shop_id INTEGER REFERENCES shops(id),
      sku_mapping_id INTEGER REFERENCES sku_mappings(id),
      owner_person_id INTEGER REFERENCES people(id),
      source_type TEXT NOT NULL,
      source_ref TEXT,
      quantity_delta INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'posted',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      posting_number TEXT NOT NULL UNIQUE,
      order_number TEXT,
      status TEXT NOT NULL,
      logistics_status TEXT NOT NULL DEFAULT 'created',
      tracking_stage TEXT NOT NULL DEFAULT 'pending_stock',
      ordered_at TEXT NOT NULL,
      delivered_at TEXT,
      accrued_at TEXT,
      buyer_region TEXT,
      tracking_number TEXT,
      external_tracking_url TEXT,
      cancel_reason_id INTEGER,
      cancel_reason TEXT,
      cancel_initiator TEXT,
      cancel_type TEXT,
      cancelled_after_ship INTEGER NOT NULL DEFAULT 0,
      cancel_loss_applies INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sku_mapping_id INTEGER REFERENCES sku_mappings(id),
      ozon_sku TEXT NOT NULL,
      ozon_name TEXT,
      ozon_image_url TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      sale_price REAL NOT NULL DEFAULT 0,
      frozen_purchase_cost REAL NOT NULL DEFAULT 0,
      frozen_domestic_shipping REAL NOT NULL DEFAULT 0,
      frozen_international_shipping REAL NOT NULL DEFAULT 0,
      frozen_handling_fee REAL NOT NULL DEFAULT 0,
      estimated_commission REAL NOT NULL DEFAULT 0,
      platform_fee_actual REAL NOT NULL DEFAULT 0,
      aftersale_loss REAL NOT NULL DEFAULT 0,
      estimated_profit REAL NOT NULL DEFAULT 0,
      actual_profit REAL NOT NULL DEFAULT 0,
      settlement_state TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS ozon_orders_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL REFERENCES shops(id),
      posting_number TEXT NOT NULL,
      order_id TEXT,
      status TEXT,
      substatus TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(store_id, posting_number)
    );

    CREATE TABLE IF NOT EXISTS order_profit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE,
      sale_amount_cny REAL NOT NULL DEFAULT 0,
      purchase_cost_cny REAL NOT NULL DEFAULT 0,
      domestic_shipping_cny REAL NOT NULL DEFAULT 0,
      international_shipping_cny REAL NOT NULL DEFAULT 0,
      packaging_cost_cny REAL NOT NULL DEFAULT 0,
      commission_rate REAL NOT NULL DEFAULT 0,
      commission_fee_cny REAL NOT NULL DEFAULT 0,
      ozon_service_fee_cny REAL NOT NULL DEFAULT 0,
      return_loss_cny REAL NOT NULL DEFAULT 0,
      advertising_cost_cny REAL NOT NULL DEFAULT 0,
      other_fee_cny REAL NOT NULL DEFAULT 0,
      gross_profit_cny REAL NOT NULL DEFAULT 0,
      net_profit_cny REAL NOT NULL DEFAULT 0,
      profit_status TEXT NOT NULL DEFAULT 'estimated',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ozon_finance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      operation_id TEXT NOT NULL,
      posting_number TEXT,
      order_number TEXT,
      operation_type TEXT,
      operation_type_name TEXT,
      operation_date TEXT,
      service_type TEXT NOT NULL DEFAULT '',
      service_name TEXT,
      amount REAL NOT NULL DEFAULT 0,
      accruals_for_sale REAL NOT NULL DEFAULT 0,
      sale_commission REAL NOT NULL DEFAULT 0,
      delivery_charge REAL NOT NULL DEFAULT 0,
      return_delivery_charge REAL NOT NULL DEFAULT 0,
      currency_code TEXT,
      raw_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, operation_id, service_type)
    );

    CREATE TABLE IF NOT EXISTS inventory_current (
      real_product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      available_stock INTEGER NOT NULL DEFAULT 0,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      damaged_stock INTEGER NOT NULL DEFAULT 0,
      in_transit_stock INTEGER NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES shops(id),
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
      posting_number TEXT,
      ozon_sku TEXT,
      exception_type TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      UNIQUE(store_id, posting_number, ozon_sku, exception_type)
    );

    CREATE TABLE IF NOT EXISTS exception_task_states (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      updated_by_person_id INTEGER REFERENCES people(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS online_product_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      online_product_id INTEGER REFERENCES online_products(id) ON DELETE SET NULL,
      shop_id INTEGER REFERENCES shops(id),
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      request_json TEXT,
      response_json TEXT,
      error_message TEXT,
      created_by_person_id INTEGER REFERENCES people(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_marks (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      mark_type TEXT NOT NULL DEFAULT '',
      note TEXT,
      updated_by_person_id INTEGER REFERENCES people(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_label_prints (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      printed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      printed_by_person_id INTEGER REFERENCES people(id)
    );

    CREATE TABLE IF NOT EXISTS order_quality_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prefix TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '质检单',
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO order_quality_rules (prefix, label, note, active)
    VALUES
      ('0213', '质检单', '疑似 Ozon 仓库质检单：不要正常发货，按仓库要求拍照处理。', 1),
      ('0249', '质检单', '疑似 Ozon 仓库质检单：不要正常发货，按仓库要求拍照处理。', 1);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency_from TEXT NOT NULL DEFAULT 'CNY',
      currency_to TEXT NOT NULL DEFAULT 'RUB',
      rate REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      effective_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      username TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      created_by_person_id INTEGER REFERENCES people(id),
      status TEXT NOT NULL DEFAULT 'pending_purchase',
      total_quantity INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      purchased_at TEXT,
      cancelled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      requested_quantity INTEGER NOT NULL DEFAULT 0,
      actual_quantity INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      shipping_amount REAL NOT NULL DEFAULT 0,
      purchase_url TEXT,
      inbound_quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_purchase',
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_person TEXT,
      contact_phone TEXT,
      wechat_id TEXT,
      business_note TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS logistics_fee_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      carrier TEXT NOT NULL DEFAULT 'CEL',
      channel TEXT NOT NULL DEFAULT 'standard',
      mode TEXT NOT NULL DEFAULT 'per_gram',
      min_weight_g REAL NOT NULL DEFAULT 0,
      max_weight_g REAL NOT NULL DEFAULT 999999,
      min_price_rub REAL NOT NULL DEFAULT 0,
      max_price_rub REAL NOT NULL DEFAULT 999999999,
      base_fee_cny REAL NOT NULL DEFAULT 0,
      per_gram_cny REAL NOT NULL DEFAULT 0,
      per_ticket_cny REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ozon_stock_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      online_product_id INTEGER REFERENCES online_products(id),
      product_id INTEGER REFERENCES products(id),
      ozon_product_id TEXT,
      ozon_sku TEXT NOT NULL,
      offer_id TEXT,
      warehouse_id TEXT,
      warehouse_name TEXT,
      stock_type TEXT NOT NULL DEFAULT 'unknown',
      present INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, ozon_sku, warehouse_id, stock_type)
    );

    CREATE TABLE IF NOT EXISTS stock_warehouse_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      stock_type TEXT NOT NULL DEFAULT 'unknown',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateDb();
  seedDemoData();
}

function migrateDb() {
  // 确保 sessions 表存在（旧数据库可能没有）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      username TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )
  `);
  addColumn("shops", "legal_entity", "TEXT");
  addColumn("people", "username", "TEXT");
  addColumn("people", "avatar_url", "TEXT");
  addColumn("people", "active", "INTEGER NOT NULL DEFAULT 1");
  addColumn("people", "password_hash", "TEXT");
  // 给没有密码的用户设置默认密码 123456
  const noPwd = db.prepare("SELECT id FROM people WHERE password_hash IS NULL OR password_hash = ''").all();
  const defaultPwdHash = hashPassword("123456");
  const setPwd = db.prepare("UPDATE people SET password_hash = ? WHERE id = ?");
  for (const row of noPwd) setPwd.run(defaultPwdHash, row.id);

  // 兼容旧数据：中文 username 自动映射为英文登录名
  const usernameMap = { "蒋": "jiang", "刘": "liu", "符": "fu" };
  const roleMap = { "蒋": "admin", "刘": "operator", "符": "listing" };
  const fixUsernames = db.prepare("SELECT id, username, name FROM people WHERE username IN ('蒋','刘','符')").all();
  const updateUsername = db.prepare("UPDATE people SET username = ?, role = ? WHERE id = ?");
  for (const row of fixUsernames) {
    const newUname = usernameMap[row.username] || usernameMap[row.name];
    const newRole = roleMap[row.username] || roleMap[row.name];
    if (newUname) {
      updateUsername.run(newUname, newRole || row.role, row.id);
    }
  }

  const productColumns = [
    ["selection_id", "TEXT"],
    ["source_platform", "TEXT NOT NULL DEFAULT '1688'"],
    ["shipping_method", "TEXT NOT NULL DEFAULT 'air_land'"],
    ["recommended_shipping_method", "TEXT NOT NULL DEFAULT 'air_land'"],
    ["handling_fee", "REAL NOT NULL DEFAULT 0"],
    ["purchase_quantity", "INTEGER NOT NULL DEFAULT 1"],
    ["package_weight_g", "REAL NOT NULL DEFAULT 0"],
    ["length_cm", "REAL NOT NULL DEFAULT 30"],
    ["width_cm", "REAL NOT NULL DEFAULT 20"],
    ["height_cm", "REAL NOT NULL DEFAULT 10"],
    ["listing_price_rub", "REAL NOT NULL DEFAULT 0"],
    ["air_sale_price_rmb", "REAL NOT NULL DEFAULT 0"],
    ["exchange_rate", "REAL NOT NULL DEFAULT 11.32"],
    ["target_margin", "REAL NOT NULL DEFAULT 0.2"],
    ["desired_profit_mode", "TEXT NOT NULL DEFAULT 'margin'"],
    ["desired_profit_value", "REAL NOT NULL DEFAULT 20"],
    ["return_rate", "REAL NOT NULL DEFAULT 0.05"],
    ["payment_fee_rate", "REAL NOT NULL DEFAULT 0.013"],
    ["withdrawal_fee_rate", "REAL NOT NULL DEFAULT 0.012"],
    ["owner_person_id", "INTEGER REFERENCES people(id)"],
    ["created_by_person_id", "INTEGER REFERENCES people(id)"],
    ["product_type", "TEXT NOT NULL DEFAULT 'main'"],
    ["parent_product_id", "INTEGER REFERENCES products(id)"],
    ["accessory_note", "TEXT"],
    ["selection_status", "TEXT NOT NULL DEFAULT 'draft'"],
    ["alert_stock", "INTEGER NOT NULL DEFAULT 5"],
    ["active", "INTEGER NOT NULL DEFAULT 1"],
    ["created_at", "TEXT"],
    ["updated_at", "TEXT"]
  ];
  for (const [column, definition] of productColumns) addColumn("products", column, definition);
  db.exec("UPDATE products SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP), updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);");

  addColumn("sku_mappings", "online_product_id", "INTEGER REFERENCES online_products(id)");
  addColumn("sku_mappings", "created_at", "TEXT");
  addColumn("sku_mappings", "updated_at", "TEXT");
  db.exec("UPDATE sku_mappings SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP), updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);");
  addColumn("procurement_requests", "amount", "REAL NOT NULL DEFAULT 0");
  addColumn("procurement_requests", "shipping_amount", "REAL NOT NULL DEFAULT 0");
  addColumn("procurement_requests", "purchase_url", "TEXT");
  addColumn("procurement_requests", "approval_status", "TEXT NOT NULL DEFAULT 'draft'");
  addColumn("procurement_requests", "urgency", "TEXT NOT NULL DEFAULT 'normal'");
  addColumn("procurement_requests", "purchase_order_id", "INTEGER REFERENCES purchase_orders(id)");
  addColumn("procurement_requests", "merged_at", "TEXT");
  addColumn("procurement_requests", "cancelled_at", "TEXT");
  addColumn("procurement_requests", "source_type", "TEXT NOT NULL DEFAULT '1688'");
  addColumn("inventory_movements", "owner_person_id", "INTEGER REFERENCES people(id)");
  addColumn("inventory_movements", "amount", "REAL NOT NULL DEFAULT 0");
  addColumn("inventory_movements", "status", "TEXT NOT NULL DEFAULT 'posted'");
  addColumn("inventory_movements", "movement_type", "TEXT");
  addColumn("inventory_movements", "related_posting_number", "TEXT");
  addColumn("inventory_movements", "related_order_item_id", "INTEGER REFERENCES order_items(id)");
  addColumn("inventory_movements", "operator", "TEXT");
  addColumn("online_products", "ozon_product_id", "TEXT");
  addColumn("online_products", "primary_image", "TEXT");
  addColumn("online_products", "currency_code", "TEXT");
  addColumn("online_products", "marketing_price", "REAL NOT NULL DEFAULT 0");
  addColumn("online_products", "old_price", "REAL NOT NULL DEFAULT 0");
  addColumn("online_products", "visibility", "TEXT");
  addColumn("online_products", "archived", "INTEGER NOT NULL DEFAULT 0");
  addColumn("online_products", "is_discounted", "INTEGER NOT NULL DEFAULT 0");
  addColumn("online_products", "images_json", "TEXT");
  addColumn("online_products", "barcodes_json", "TEXT");
  addColumn("online_products", "stocks_json", "TEXT");
  addColumn("online_products", "commissions_json", "TEXT");
  addColumn("online_products", "attributes_json", "TEXT");
  addColumn("online_products", "raw_json", "TEXT");
  addColumn("online_products", "ozon_updated_at", "TEXT");
  addColumn("online_products", "updated_at", "TEXT");
  addColumn("orders", "tracking_stage", "TEXT NOT NULL DEFAULT 'pending_stock'");
  addColumn("orders", "external_tracking_url", "TEXT");
  addColumn("orders", "sync_state", "TEXT NOT NULL DEFAULT 'open'");
  addColumn("orders", "finalized_at", "TEXT");
  addColumn("orders", "last_synced_at", "TEXT");
  addColumn("orders", "last_status_changed_at", "TEXT");
  addColumn("orders", "sync_note", "TEXT");
  addColumn("orders", "cancel_reason_id", "INTEGER");
  addColumn("orders", "cancel_reason", "TEXT");
  addColumn("orders", "cancel_initiator", "TEXT");
  addColumn("orders", "cancel_type", "TEXT");
  addColumn("orders", "cancelled_after_ship", "INTEGER NOT NULL DEFAULT 0");
  addColumn("orders", "cancel_loss_applies", "INTEGER NOT NULL DEFAULT 0");
  addColumn("order_items", "ozon_name", "TEXT");
  addColumn("order_items", "ozon_image_url", "TEXT");
  addColumn("inbound_records", "purchase_order_id", "INTEGER REFERENCES purchase_orders(id)");
  addColumn("inbound_records", "purchase_order_item_id", "INTEGER REFERENCES purchase_order_items(id)");
  addColumn("inbound_records", "qc_status", "TEXT NOT NULL DEFAULT 'pending'");
  addColumn("inbound_records", "shipping_amount", "REAL NOT NULL DEFAULT 0");
  addColumn("purchase_order_items", "shipping_amount", "REAL NOT NULL DEFAULT 0");
  addColumn("outbound_records", "order_item_id", "INTEGER REFERENCES order_items(id)");
  addColumn("outbound_records", "ozon_sku", "TEXT");
  addColumn("products", "supplier_id", "INTEGER REFERENCES suppliers(id)");
  addColumn("procurement_requests", "supplier_id", "INTEGER REFERENCES suppliers(id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS logistics_fee_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      carrier TEXT NOT NULL DEFAULT 'CEL',
      channel TEXT NOT NULL DEFAULT 'standard',
      mode TEXT NOT NULL DEFAULT 'per_gram',
      min_weight_g REAL NOT NULL DEFAULT 0,
      max_weight_g REAL NOT NULL DEFAULT 999999,
      min_price_rub REAL NOT NULL DEFAULT 0,
      max_price_rub REAL NOT NULL DEFAULT 999999999,
      base_fee_cny REAL NOT NULL DEFAULT 0,
      per_gram_cny REAL NOT NULL DEFAULT 0,
      per_ticket_cny REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ozon_stock_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      online_product_id INTEGER REFERENCES online_products(id),
      product_id INTEGER REFERENCES products(id),
      ozon_product_id TEXT,
      ozon_sku TEXT NOT NULL,
      offer_id TEXT,
      warehouse_id TEXT,
      warehouse_name TEXT,
      stock_type TEXT NOT NULL DEFAULT 'unknown',
      present INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, ozon_sku, warehouse_id, stock_type)
    );

    CREATE TABLE IF NOT EXISTS stock_warehouse_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      stock_type TEXT NOT NULL DEFAULT 'unknown',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_raw_orders_store_posting ON ozon_orders_raw(store_id, posting_number);
    CREATE INDEX IF NOT EXISTS idx_profit_order_item ON order_profit_items(order_item_id);
    CREATE INDEX IF NOT EXISTS idx_finance_posting ON ozon_finance_items(shop_id, posting_number);
    CREATE INDEX IF NOT EXISTS idx_finance_operation_date ON ozon_finance_items(operation_date DESC);
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON order_exceptions(status, exception_type);
    CREATE INDEX IF NOT EXISTS idx_exception_task_states_status ON exception_task_states(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_online_product_actions_product ON online_product_actions(online_product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inventory_product_status ON inventory_movements(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_inventory_related_order_item ON inventory_movements(related_order_item_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_order_item ON outbound_records(order_item_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_order_sku ON outbound_records(order_ref, product_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_mapping ON order_items(sku_mapping_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_product_shop ON sku_mappings(product_id, shop_id);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_shop_sku_active ON sku_mappings(shop_id, ozon_sku, active);
    CREATE INDEX IF NOT EXISTS idx_orders_shop_stage ON orders(shop_id, tracking_stage);
    CREATE INDEX IF NOT EXISTS idx_orders_sync_state ON orders(sync_state, ordered_at);
    CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_shop_ordered_at ON orders(shop_id, ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_posting ON orders(posting_number);
    CREATE INDEX IF NOT EXISTS idx_online_products_shop_status ON online_products(shop_id, status);
    CREATE INDEX IF NOT EXISTS idx_online_products_shop_sku ON online_products(shop_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_online_products_synced ON online_products(synced_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logistics_rules_match ON logistics_fee_rules(enabled, carrier, channel, min_weight_g, max_weight_g);
    CREATE INDEX IF NOT EXISTS idx_ozon_stock_sku ON ozon_stock_snapshots(shop_id, ozon_sku, stock_type);
    CREATE INDEX IF NOT EXISTS idx_ozon_stock_product ON ozon_stock_snapshots(product_id, synced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_warehouse_rules ON stock_warehouse_rules(enabled, priority);
    CREATE INDEX IF NOT EXISTS idx_procurement_status ON procurement_requests(status, purchase_order_id);
    CREATE INDEX IF NOT EXISTS idx_procurement_status_created ON procurement_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_procurement_product_status ON procurement_requests(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order ON purchase_order_items(purchase_order_id);
    CREATE INDEX IF NOT EXISTS idx_inbound_purchase_item ON inbound_records(purchase_order_item_id, status);
    CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_records(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbound_product_status ON inbound_records(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_inbound_status_created ON inbound_records(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbound_status_created ON outbound_records(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_records(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_outbound_order_ref ON outbound_records(order_ref);
    CREATE INDEX IF NOT EXISTS idx_products_active_id ON products(active, id DESC);
    CREATE INDEX IF NOT EXISTS idx_products_owner_active ON products(owner_person_id, active);
    CREATE INDEX IF NOT EXISTS idx_inventory_source_ref ON inventory_movements(source_type, source_ref);
    CREATE INDEX IF NOT EXISTS idx_inventory_related_posting ON inventory_movements(related_posting_number, product_id, source_type, status);
    CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date ON exchange_rates(currency_from, currency_to, effective_date DESC, id DESC);
  `);

  seedExchangeRate();
  seedLogisticsRules();
  seedStockWarehouseRules();
  backfillOutboundAuditFields();
  rebuildInventoryCurrent();
}

function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function seedExchangeRate() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM exchange_rates").get().count;
  if (count) return;
  db.prepare(`
    INSERT INTO exchange_rates (currency_from, currency_to, rate, source, effective_date, note)
    VALUES ('CNY', 'RUB', 11.32, 'fallback', date('now'), 'Initial fallback rate; update from Config before live use')
  `).run();
}

function seedLogisticsRules() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM logistics_fee_rules").get().count;
  if (count) return;
  const stmt = db.prepare(`
    INSERT INTO logistics_fee_rules
    (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, per_gram_cny, per_ticket_cny, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run("CEL 陆空标准 Extra Small", "CEL", "standard", "per_gram", 1, 500, 1, 1500, 0.0364, 3.12, "当前硬编码公式中的轻小件陆空标准档，后续会由规则表驱动。");
  stmt.run("CEL 陆运经济 Extra Small", "CEL", "economy", "per_gram", 1, 500, 1, 1500, 0.026, 3.12, "当前硬编码公式中的轻小件陆运经济档。");
  stmt.run("中国邮政 500g 以下", "China Post", "economy", "per_gram", 1, 500, 0, 999999, 0.026, 1.9, "按你提供的轻小件示例预置：首票 1.9，每克 0.026。");
}

function seedStockWarehouseRules() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM stock_warehouse_rules").get().count;
  if (count) return;
  const stmt = db.prepare(`
    INSERT INTO stock_warehouse_rules (pattern, stock_type, priority, note)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run("FBS", "fbs_virtual", 10, "Ozon 后台卖家自发货虚拟库存。");
  stmt.run("rFBS", "fbs_virtual", 11, "Ozon rFBS 自发货库存。");
  stmt.run("seller", "fbs_virtual", 20, "英文卖家仓/虚拟仓兜底。");
  stmt.run("virtual", "fbs_virtual", 21, "虚拟库存兜底。");
  stmt.run("自发", "fbs_virtual", 22, "中文自发货兜底。");
  stmt.run("FBP", "fbp_real", 10, "FBP 官方合作仓真实库存。");
  stmt.run("FBO", "fbp_real", 11, "Ozon 官方仓库存。");
  stmt.run("CEL", "fbp_real", 15, "CEL 合作仓/物流仓。");
  stmt.run("CL ", "fbp_real", 16, "CL 仓库前缀。");
  stmt.run("Hunchun", "fbp_real", 17, "珲春/混春仓英文拼写。");
  stmt.run("хуньчун", "fbp_real", 18, "珲春仓俄文拼写。");
  stmt.run("混春", "fbp_real", 19, "仓库名常见错字兜底。");
  stmt.run("混川", "fbp_real", 20, "仓库名常见错字兜底。");
}

function backfillOutboundAuditFields() {
  db.exec(`
    UPDATE outbound_records
    SET
      order_item_id = COALESCE(order_item_id, (
        SELECT im.related_order_item_id
        FROM inventory_movements im
        WHERE im.related_posting_number = outbound_records.order_ref
          AND im.product_id = outbound_records.product_id
          AND im.source_type = 'order_outbound'
          AND im.related_order_item_id IS NOT NULL
        ORDER BY im.id DESC
        LIMIT 1
      ))
    WHERE order_ref IS NOT NULL
      AND order_item_id IS NULL;

    UPDATE outbound_records
    SET ozon_sku = COALESCE(NULLIF(ozon_sku, ''), (
        SELECT oi.ozon_sku
        FROM order_items oi
        WHERE oi.id = outbound_records.order_item_id
        LIMIT 1
      ))
    WHERE order_ref IS NOT NULL
      AND order_item_id IS NOT NULL
      AND (ozon_sku IS NULL OR ozon_sku = '');
  `);
}

function rebuildInventoryCurrent() {
  db.exec(`
    INSERT INTO inventory_current (real_product_id, available_stock, last_updated_at)
    SELECT product_id, COALESCE(SUM(quantity_delta), 0), CURRENT_TIMESTAMP
    FROM inventory_movements
    WHERE status = 'posted'
    GROUP BY product_id
    ON CONFLICT(real_product_id) DO UPDATE SET
      available_stock = excluded.available_stock,
      last_updated_at = CURRENT_TIMESTAMP;
  `);
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function seedDemoData() {
  if (db.prepare("SELECT COUNT(*) AS count FROM shops").get().count === 0) {
    const stmt = db.prepare("INSERT INTO shops (name, legal_entity, ozon_client_id, api_key_hint, payout_rate) VALUES (?, ?, ?, ?, ?)");
    stmt.run("A Store", "License A", "demo-client-a", "demo-key-a", 0.34);
    stmt.run("B Store", "License B", "demo-client-b", "demo-key-b", 0.33);
    stmt.run("C Store", "License C", "demo-client-c", "demo-key-c", 0.33);
  }

  if (db.prepare("SELECT COUNT(*) AS count FROM people").get().count === 0) {
    const stmt = db.prepare("INSERT INTO people (name, username, role, password_hash) VALUES (?, ?, ?, ?)");
    const defaultPwd = "123456";
    stmt.run("蒋", "jiang", "admin", hashPassword(defaultPwd));
    stmt.run("刘", "liu", "operator", hashPassword(defaultPwd));
    stmt.run("符", "fu", "listing", hashPassword(defaultPwd));
  }

  if (db.prepare("SELECT COUNT(*) AS count FROM products").get().count === 0) {
    createSeedProduct({
      selection_id: "SEL-20260501-001",
      code: "PRD-20260501-001",
      name: "Foldable storage box",
      image_url: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=500",
      purchase_url: "https://example.com/1688/P-1001",
      supplier_note: "White and gray colors. Check color before purchase.",
      purchase_cost: 4,
      domestic_shipping: 3,
      purchase_quantity: 10,
      package_weight_g: 30,
      length_cm: 20,
      width_cm: 20,
      height_cm: 20,
      listing_price_rub: 32,
      air_sale_price_rmb: 16,
      owner_person_id: 1,
      selection_status: "listed"
    });
    createSeedProduct({
      selection_id: "SEL-20260501-002",
      code: "PRD-20260501-002",
      name: "Kitchen silicone mat",
      image_url: "https://images.unsplash.com/photo-1556911220-bff31c812dba?w=500",
      purchase_url: "https://example.com/pdd/P-1002",
      supplier_note: "PDD spot goods. Confirm color.",
      source_platform: "pdd",
      purchase_cost: 12,
      domestic_shipping: 5,
      purchase_quantity: 10,
      package_weight_g: 300,
      length_cm: 28,
      width_cm: 18,
      height_cm: 4,
      listing_price_rub: 58,
      air_sale_price_rmb: 29,
      owner_person_id: 1,
      selection_status: "listed"
    });
  }

  if (db.prepare("SELECT COUNT(*) AS count FROM online_products").get().count === 0) {
    const stmt = db.prepare(`
      INSERT INTO online_products (shop_id, ozon_sku, offer_id, name, image_url, sale_price, product_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(1, "SKU-A-BOX-01", "A-BOX-01", "A store storage box main image", "", 32, 1);
    stmt.run(2, "SKU-B-BOX-77", "B-BOX-77", "B store storage box white background", "", 32, 1);
    stmt.run(1, "SKU-A-MAT-11", "A-MAT-11", "Kitchen silicone mat", "", 58, 2);
  }

  if (db.prepare("SELECT COUNT(*) AS count FROM sku_mappings").get().count === 0) {
    const stmt = db.prepare(`
      INSERT INTO sku_mappings (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(1, 1, 1, 1, "SKU-A-BOX-01", "A-BOX-01", "A store storage box");
    stmt.run(2, 1, 2, 2, "SKU-B-BOX-77", "B-BOX-77", "B store storage box");
    stmt.run(1, 2, 1, 3, "SKU-A-MAT-11", "A-MAT-11", "Kitchen mat");
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64, { N: 16384 }).toString("hex");
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(input, storedHash) {
  if (!storedHash) return false;

  // 新格式：scrypt:salt:key
  if (storedHash.startsWith("scrypt:")) {
    const parts = storedHash.split(":");
    if (parts.length !== 3) return false;
    const [, salt, key] = parts;
    const inputKey = scryptSync(input, salt, 64, { N: 16384 }).toString("hex");
    try {
      return timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(inputKey, "hex"));
    } catch {
      return false;
    }
  }

  // 旧格式：salt:sha256hash（SHA-256 无迭代）
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const inputHash = createHash("sha256").update(salt + input).digest("hex");
  return inputHash === hash;
}

export function isLegacyHash(storedHash) {
  return storedHash && !storedHash.startsWith("scrypt:");
}

if (tableExists("people") && db.prepare("SELECT COUNT(*) AS count FROM people").get().count === 0) {
  const stmt = db.prepare("INSERT INTO people (name, username, role, password_hash) VALUES (?, ?, ?, ?)");
  const defaultPwd = "123456";
  stmt.run("蒋", "jiang", "admin", hashPassword(defaultPwd));
  stmt.run("刘", "liu", "operator", hashPassword(defaultPwd));
  stmt.run("符", "fu", "listing", hashPassword(defaultPwd));
}

  if (tableExists("products") && db.prepare("SELECT COUNT(*) AS count FROM products").get().count === 0) {
    createSeedProduct({
      selection_id: "SEL-20260501-001",
      code: "PRD-20260501-001",
      name: "Foldable storage box",
      image_url: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=500",
      purchase_url: "https://example.com/1688/P-1001",
      supplier_note: "White and gray colors. Check color before purchase.",
      purchase_cost: 4,
      domestic_shipping: 3,
      purchase_quantity: 10,
      package_weight_g: 30,
      length_cm: 20,
      width_cm: 20,
      height_cm: 20,
      listing_price_rub: 32,
      air_sale_price_rmb: 16,
      owner_person_id: 1,
      selection_status: "listed"
    });
    createSeedProduct({
      selection_id: "SEL-20260501-002",
      code: "PRD-20260501-002",
      name: "Kitchen silicone mat",
      image_url: "https://images.unsplash.com/photo-1556911220-bff31c812dba?w=500",
      purchase_url: "https://example.com/pdd/P-1002",
      supplier_note: "PDD spot goods. Confirm color.",
      source_platform: "pdd",
      purchase_cost: 12,
      domestic_shipping: 5,
      purchase_quantity: 10,
      package_weight_g: 300,
      length_cm: 28,
      width_cm: 18,
      height_cm: 4,
      listing_price_rub: 58,
      air_sale_price_rmb: 29,
      owner_person_id: 1,
      selection_status: "listed"
    });
  }

  if (tableExists("online_products") && db.prepare("SELECT COUNT(*) AS count FROM online_products").get().count === 0) {
    const stmt = db.prepare(`
      INSERT INTO online_products (shop_id, ozon_sku, offer_id, name, image_url, sale_price, product_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(1, "SKU-A-BOX-01", "A-BOX-01", "A store storage box main image", "", 32, 1);
    stmt.run(2, "SKU-B-BOX-77", "B-BOX-77", "B store storage box white background", "", 32, 1);
    stmt.run(1, "SKU-A-MAT-11", "A-MAT-11", "Kitchen silicone mat", "", 58, 2);
  }

  if (tableExists("sku_mappings") && db.prepare("SELECT COUNT(*) AS count FROM sku_mappings").get().count === 0) {
    const stmt = db.prepare(`
      INSERT INTO sku_mappings (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(1, 1, 1, 1, "SKU-A-BOX-01", "A-BOX-01", "A store storage box");
    stmt.run(2, 1, 2, 2, "SKU-B-BOX-77", "B-BOX-77", "B store storage box");
    stmt.run(1, 2, 1, 3, "SKU-A-MAT-11", "A-MAT-11", "Kitchen mat");
  }

function createSeedProduct(row) {
  db.prepare(`
    INSERT INTO products
    (selection_id, code, name, image_url, purchase_url, supplier_note, source_platform, shipping_method,
     recommended_shipping_method, purchase_cost, domestic_shipping, purchase_quantity, package_weight_g,
     length_cm, width_cm, height_cm, listing_price_rub, air_sale_price_rmb, owner_person_id, selection_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.selection_id,
    row.code,
    row.name,
    row.image_url || "",
    row.purchase_url || "",
    row.supplier_note || "",
    row.source_platform || "1688",
    row.shipping_method || "air_land",
    row.recommended_shipping_method || "air_land",
    row.purchase_cost || 0,
    row.domestic_shipping || 0,
    row.purchase_quantity || 1,
    row.package_weight_g || 0,
    row.length_cm || 30,
    row.width_cm || 20,
    row.height_cm || 10,
    row.listing_price_rub || 0,
    row.air_sale_price_rmb || 0,
    row.owner_person_id || 1,
    row.selection_status || "draft"
  );
}
