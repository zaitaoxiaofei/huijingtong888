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
  // 数据模型按“真实产品 -> 在线 SKU -> 订单/库存/利润”展开：
  // products 表示内部真实货品，online_products 表示 Ozon SKU，sku_mappings 负责绑定关系。
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
      -- 库存使用流水账模式，当前库存由流水汇总得出，便于审计和重算。
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
      -- 订单项冻结下单时的成本快照，避免产品成本变更后污染历史利润。
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
      -- 利润拆解单独建表，便于后续补充广告费、售后损失、财务修正等维度。
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
      is_locked INTEGER NOT NULL DEFAULT 0,
      locked_at TEXT,
      lock_reason TEXT,
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

    CREATE TABLE IF NOT EXISTS analytics_shop_daily (
      date_key TEXT NOT NULL,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      order_count INTEGER NOT NULL DEFAULT 0,
      item_quantity INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      estimated_profit REAL NOT NULL DEFAULT 0,
      confirmed_profit REAL NOT NULL DEFAULT 0,
      current_profit REAL NOT NULL DEFAULT 0,
      cancelled_orders INTEGER NOT NULL DEFAULT 0,
      cancelled_revenue REAL NOT NULL DEFAULT 0,
      return_orders INTEGER NOT NULL DEFAULT 0,
      return_quantity INTEGER NOT NULL DEFAULT 0,
      return_revenue REAL NOT NULL DEFAULT 0,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_key, shop_id)
    );

    CREATE TABLE IF NOT EXISTS analytics_product_profit_daily (
      date_key TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      order_count INTEGER NOT NULL DEFAULT 0,
      item_quantity INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      estimated_profit REAL NOT NULL DEFAULT 0,
      confirmed_profit REAL NOT NULL DEFAULT 0,
      current_profit REAL NOT NULL DEFAULT 0,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_key, product_id, shop_id)
    );

    CREATE TABLE IF NOT EXISTS analytics_sku_profit_daily (
      date_key TEXT NOT NULL,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      ozon_sku TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id),
      order_count INTEGER NOT NULL DEFAULT 0,
      item_quantity INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      estimated_profit REAL NOT NULL DEFAULT 0,
      confirmed_profit REAL NOT NULL DEFAULT 0,
      current_profit REAL NOT NULL DEFAULT 0,
      cancelled_orders INTEGER NOT NULL DEFAULT 0,
      cancelled_quantity INTEGER NOT NULL DEFAULT 0,
      cancelled_revenue REAL NOT NULL DEFAULT 0,
      return_orders INTEGER NOT NULL DEFAULT 0,
      return_quantity INTEGER NOT NULL DEFAULT 0,
      return_revenue REAL NOT NULL DEFAULT 0,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_key, shop_id, ozon_sku)
    );

    CREATE TABLE IF NOT EXISTS analytics_cache (
      cache_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cache_type, cache_key)
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

    CREATE TABLE IF NOT EXISTS historical_profit_reviews (
      order_item_id INTEGER PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
      review_status TEXT NOT NULL DEFAULT 'pending',
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

    CREATE TABLE IF NOT EXISTS order_cancellation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      match_text TEXT NOT NULL,
      match_mode TEXT NOT NULL DEFAULT 'contains',
      initiator_label TEXT NOT NULL DEFAULT '',
      reason_label TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT 'other',
      reason_group_label TEXT NOT NULL DEFAULT '其他取消/退货原因',
      accounting_hint TEXT NOT NULL DEFAULT '',
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
  addColumn("ozon_finance_items", "amount_cny", "REAL NOT NULL DEFAULT 0");
  addColumn("ozon_finance_items", "accruals_for_sale_cny", "REAL NOT NULL DEFAULT 0");
  addColumn("ozon_finance_items", "sale_commission_cny", "REAL NOT NULL DEFAULT 0");
  addColumn("ozon_finance_items", "delivery_charge_cny", "REAL NOT NULL DEFAULT 0");
  addColumn("ozon_finance_items", "return_delivery_charge_cny", "REAL NOT NULL DEFAULT 0");
  addColumn("ozon_finance_items", "exchange_rate", "REAL NOT NULL DEFAULT 11.32");
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
  addColumn("order_items", "ozon_product_id", "TEXT");
  addColumn("order_profit_items", "is_locked", "INTEGER NOT NULL DEFAULT 0");
  addColumn("order_profit_items", "locked_at", "TEXT");
  addColumn("order_profit_items", "lock_reason", "TEXT");
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

    CREATE TABLE IF NOT EXISTS order_cancellation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      match_text TEXT NOT NULL,
      match_mode TEXT NOT NULL DEFAULT 'contains',
      initiator_label TEXT NOT NULL DEFAULT '',
      reason_label TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT 'other',
      reason_group_label TEXT NOT NULL DEFAULT '其他取消/退货原因',
      accounting_hint TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analytics_cache (
      cache_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cache_type, cache_key)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_raw_orders_store_posting ON ozon_orders_raw(store_id, posting_number);
    CREATE INDEX IF NOT EXISTS idx_profit_order_item ON order_profit_items(order_item_id);
    CREATE INDEX IF NOT EXISTS idx_profit_status_locked ON order_profit_items(profit_status, is_locked, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_finance_posting ON ozon_finance_items(shop_id, posting_number);
    CREATE INDEX IF NOT EXISTS idx_finance_operation_date ON ozon_finance_items(operation_date DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_shop_daily_date_shop ON analytics_shop_daily(date_key DESC, shop_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_product_daily_date_shop ON analytics_product_profit_daily(date_key DESC, shop_id, product_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_sku_daily_date_shop ON analytics_sku_profit_daily(date_key DESC, shop_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_analytics_cache_type_key ON analytics_cache(cache_type, cache_key);
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON order_exceptions(status, exception_type);
    CREATE INDEX IF NOT EXISTS idx_exception_task_states_status ON exception_task_states(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_online_product_actions_product ON online_product_actions(online_product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inventory_product_status ON inventory_movements(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_inventory_related_order_item ON inventory_movements(related_order_item_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_order_item ON outbound_records(order_item_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_order_sku ON outbound_records(order_ref, product_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_sku ON order_items(order_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_order_items_mapping ON order_items(sku_mapping_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_mapping ON order_items(order_id, sku_mapping_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_product_shop ON sku_mappings(product_id, shop_id);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_shop_sku_active ON sku_mappings(shop_id, ozon_sku, active);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_shop_offer_active ON sku_mappings(shop_id, offer_id, active);
    CREATE INDEX IF NOT EXISTS idx_orders_shop_stage ON orders(shop_id, tracking_stage);
    CREATE INDEX IF NOT EXISTS idx_orders_sync_state ON orders(sync_state, ordered_at);
    CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_shop_ordered_at ON orders(shop_id, ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_ordered_at ON orders(status, ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_shop_status_ordered_at ON orders(shop_id, status, ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_posting ON orders(posting_number);
    CREATE INDEX IF NOT EXISTS idx_online_products_shop_status ON online_products(shop_id, status);
    CREATE INDEX IF NOT EXISTS idx_online_products_shop_sku ON online_products(shop_id, ozon_sku);
    CREATE INDEX IF NOT EXISTS idx_online_products_shop_offer ON online_products(shop_id, offer_id);
    CREATE INDEX IF NOT EXISTS idx_online_products_synced ON online_products(synced_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_order_marks_type_order ON order_marks(mark_type, order_id);
    CREATE INDEX IF NOT EXISTS idx_order_label_prints_order ON order_label_prints(order_id, printed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logistics_rules_match ON logistics_fee_rules(enabled, carrier, channel, min_weight_g, max_weight_g);
    CREATE INDEX IF NOT EXISTS idx_ozon_stock_sku ON ozon_stock_snapshots(shop_id, ozon_sku, stock_type);
    CREATE INDEX IF NOT EXISTS idx_ozon_stock_product ON ozon_stock_snapshots(product_id, synced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_warehouse_rules ON stock_warehouse_rules(enabled, priority);
    CREATE INDEX IF NOT EXISTS idx_order_cancellation_rules_enabled ON order_cancellation_rules(enabled, priority);
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
    CREATE INDEX IF NOT EXISTS idx_historical_profit_reviews_status ON historical_profit_reviews(review_status, updated_at DESC);
  `);

  seedExchangeRate();
  seedLogisticsRules();
  backfillLogisticsRules();
  seedStockWarehouseRules();
  seedOrderCancellationRules();
  upgradeOrderCancellationRules();
  repairCorruptedOrderCancellationRules();
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

function defaultLogisticsRules() {
  return [
    { name: "CEL 陆空特快 Extra Small", carrier: "CEL", channel: "express", mode: "per_gram", min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.0468, per_ticket_cny: 3.12, note: "CEL 轻小件 Extra Small 档，陆空特快渠道。" },
    { name: "CEL 陆空标准 Extra Small", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.0364, per_ticket_cny: 3.12, note: "CEL 轻小件 Extra Small 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Extra Small", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 3.12, note: "CEL 轻小件 Extra Small 档，陆运经济渠道。" },
    { name: "CEL 陆空特快 Budget", carrier: "CEL", channel: "express", mode: "per_gram", min_weight_g: 501, max_weight_g: 30000, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.03432, per_ticket_cny: 23.92, note: "CEL 低客单 Budget 档，陆空特快渠道。" },
    { name: "CEL 陆空标准 Budget", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 501, max_weight_g: 30000, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 23.92, note: "CEL 低客单 Budget 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Budget", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 501, max_weight_g: 30000, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: 0.01768, per_ticket_cny: 23.92, note: "CEL 低客单 Budget 档，陆运经济渠道。" },
    { name: "CEL 陆空特快 Small", carrier: "CEL", channel: "express", mode: "per_gram", min_weight_g: 1, max_weight_g: 2000, min_price_rub: 1501, max_price_rub: 7000, base_fee_cny: 0, per_gram_cny: 0.0468, per_ticket_cny: 16.64, note: "CEL 小件 Small 档，陆空特快渠道。" },
    { name: "CEL 陆空标准 Small", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 1, max_weight_g: 2000, min_price_rub: 1501, max_price_rub: 7000, base_fee_cny: 0, per_gram_cny: 0.0364, per_ticket_cny: 16.64, note: "CEL 小件 Small 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Small", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 1, max_weight_g: 2000, min_price_rub: 1501, max_price_rub: 7000, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 16.64, note: "CEL 小件 Small 档，陆运经济渠道。" },
    { name: "CEL 陆空标准 Big", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 2001, max_weight_g: 30000, min_price_rub: 1501, max_price_rub: 7000, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 37.44, note: "CEL 大件 Big 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Big", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 2001, max_weight_g: 30000, min_price_rub: 1501, max_price_rub: 7000, base_fee_cny: 0, per_gram_cny: 0.01768, per_ticket_cny: 37.44, note: "CEL 大件 Big 档，陆运经济渠道。" },
    { name: "CEL 陆空特快 Premium Small", carrier: "CEL", channel: "express", mode: "per_gram", min_weight_g: 1, max_weight_g: 5000, min_price_rub: 7001, max_price_rub: 250000, base_fee_cny: 0, per_gram_cny: 0.0468, per_ticket_cny: 22.88, note: "CEL 高客单 Premium Small 档，陆空特快渠道。" },
    { name: "CEL 陆空标准 Premium Small", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 1, max_weight_g: 5000, min_price_rub: 7001, max_price_rub: 250000, base_fee_cny: 0, per_gram_cny: 0.0364, per_ticket_cny: 22.88, note: "CEL 高客单 Premium Small 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Premium Small", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 1, max_weight_g: 5000, min_price_rub: 7001, max_price_rub: 250000, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 22.88, note: "CEL 高客单 Premium Small 档，陆运经济渠道。" },
    { name: "CEL 陆空标准 Premium Big", carrier: "CEL", channel: "standard", mode: "per_gram", min_weight_g: 5001, max_weight_g: 30000, min_price_rub: 7001, max_price_rub: 250000, base_fee_cny: 0, per_gram_cny: 0.02912, per_ticket_cny: 64.48, note: "CEL 高客单 Premium Big 档，陆空标准渠道。" },
    { name: "CEL 陆运经济 Premium Big", carrier: "CEL", channel: "economy", mode: "per_gram", min_weight_g: 5001, max_weight_g: 30000, min_price_rub: 7001, max_price_rub: 250000, base_fee_cny: 0, per_gram_cny: 0.02392, per_ticket_cny: 64.48, note: "CEL 高客单 Premium Big 档，陆运经济渠道。" },
    { name: "CEL 香港空运 HK", carrier: "CEL", channel: "hk_express", mode: "per_gram", min_weight_g: 1, max_weight_g: 25000, min_price_rub: 1, max_price_rub: 500000, base_fee_cny: 0, per_gram_cny: 0.096, per_ticket_cny: 19, note: "CEL 香港渠道 HK 档，香港空运渠道。" },
    { name: "中国邮政 500g 以下", carrier: "China Post", channel: "economy", mode: "per_gram", min_weight_g: 1, max_weight_g: 500, min_price_rub: 0, max_price_rub: 999999, base_fee_cny: 0, per_gram_cny: 0.026, per_ticket_cny: 1.9, note: "中国邮政轻小件示例规则：首票 1.9，每克 0.026。" }
  ];
}

function seedLogisticsRules() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM logistics_fee_rules").get().count;
  if (count) return;
  const stmt = db.prepare(`
    INSERT INTO logistics_fee_rules
    (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of defaultLogisticsRules()) {
    stmt.run(
      rule.name,
      rule.carrier,
      rule.channel,
      rule.mode,
      rule.min_weight_g,
      rule.max_weight_g,
      rule.min_price_rub,
      rule.max_price_rub,
      rule.base_fee_cny,
      rule.per_gram_cny,
      rule.per_ticket_cny,
      rule.note
    );
  }
}

function backfillLogisticsRules() {
  const exists = db.prepare("SELECT id FROM logistics_fee_rules WHERE name = ? LIMIT 1");
  const insert = db.prepare(`
    INSERT INTO logistics_fee_rules
    (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny, enabled, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of defaultLogisticsRules()) {
    if (exists.get(rule.name)) continue;
    insert.run(
      rule.name,
      rule.carrier,
      rule.channel,
      rule.mode,
      rule.min_weight_g,
      rule.max_weight_g,
      rule.min_price_rub,
      rule.max_price_rub,
      rule.base_fee_cny,
      rule.per_gram_cny,
      rule.per_ticket_cny,
      1,
      rule.note
    );
  }
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

function seedOrderCancellationRules() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM order_cancellation_rules").get().count;
  if (count) return;
  const stmt = db.prepare(`
    INSERT INTO order_cancellation_rules
    (name, match_text, match_mode, initiator_label, reason_label, reason_code, reason_group_label, accounting_hint, priority, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run("买家未取货", "не забрал", "contains", "买家", "买家未取货", "unclaimed_or_rejected", "拒收/未取", "通常不计入有效销售，真实损失按拒收/未取模型处理。", 10, "俄语未取货关键词");
  stmt.run("拒收/未签收", "not accepted", "contains", "买家", "拒收/未签收", "unclaimed_or_rejected", "拒收/未取", "通常不计入有效销售，真实损失按拒收/未取模型处理。", 11, "英文拒收关键词");
  stmt.run("退货/退款", "возврат", "contains", "", "退货/退款", "return_or_refund", "退货/退款", "通常不计入有效销售，真实损失按退货模型处理。", 20, "俄语退货关键词");
  stmt.run("配送时效问题", "срок доставки", "contains", "", "不满意配送时间", "delivery_delay", "配送时效问题", "需结合结果类型判断；若只是履约前取消，通常不计真实亏损。", 30, "配送时效问题");
  stmt.run("商品缺货", "stock", "contains", "卖家", "商品缺货", "out_of_stock", "缺货", "通常属于履约前取消，不计入真实销售和真实亏损。", 40, "缺货类原因");
  stmt.run("信息填写错误", "ошиб", "contains", "买家", "下单信息填写错误", "input_error", "信息错误", "通常属于履约前取消，不计入真实销售和真实亏损。", 50, "填写错误类原因");
  stmt.run("找到更便宜商品", "дешев", "contains", "买家", "找到更便宜商品", "price_change", "价格原因取消", "通常属于履约前取消，不计入真实销售和真实亏损。", 60, "价格因素");
  stmt.run("质检/平台核验", "проверка товара", "contains", "平台", "质检/平台核验", "quality_inspection", "质检/平台核验", "通常不作为正常销售，也不应直接按用户退货损失处理。", 70, "质检核验类订单");
}

function upgradeOrderCancellationRules() {
  const defaults = [
    ["买家拒收不合适", "товар не подошел", "contains", "买家", "买家拒收：商品不合适", "unclaimed_or_rejected", "拒收/未取", "通常不计入有效销售，真实损失按拒收/未取模型处理。", 12, "真实高频：买家签收点/派送时拒收，商品不合适"],
    ["买家拒收质量问题", "недоволен качеством товара", "contains", "买家", "买家拒收：质量问题", "aftersale_quality_issue", "签收后/拒收质量问题", "通常不计入有效销售，需要重点核对是否按质量问题退货模型处理。", 13, "真实高频：对商品质量不满意"],
    ["买家拒收发错货", "в заказе не тот товар", "contains", "卖家", "买家拒收：发错货", "wrong_item", "发错货/错配", "通常不计入有效销售，需要重点核对是否按售后责任损失处理。", 14, "真实高频：订单内商品不符"],
    ["买家未提供护照", "паспортные данные", "contains", "买家", "买家未提供护照信息", "missing_passport", "证件信息缺失", "通常属于已发货后无法清关/妥投场景，不计入有效销售，需按拒收/退回模型核对。", 15, "真实样本：未提供护照数据"],
    ["平台无法妥投", "не удалось доставить заказ", "contains", "平台", "平台未能完成配送", "delivery_failed", "配送失败", "通常不计入有效销售，需要结合是否已发货确认损失口径。", 16, "真实高频：平台配送失败"],
    ["平台未能登记发运", "не удалось зарегистрировать отправление", "contains", "平台", "平台未能登记发运", "shipment_registration_failed", "发运登记失败", "通常需要结合是否实际发出判断；若未实际履约，可按履约前取消处理。", 17, "真实样本：配送服务登记失败"],
    ["平台清关失败", "таможенное оформление", "contains", "平台", "清关失败", "customs_failed", "清关失败", "通常属于已发货后异常退回，不计入有效销售，需核对真实损失。", 18, "真实样本：未通过海关"],
    ["卖家主动取消", "вы отменили заказ", "contains", "卖家", "卖家主动取消", "seller_cancelled", "卖家取消", "通常不计入有效销售；若已发货后取消，需要结合实际履约判断损失。", 19, "真实样本：卖家取消"],
    ["买家要求卖家取消", "попросил вас отменить заказ", "contains", "买家", "买家要求卖家取消", "buyer_requested_cancel", "买家请求取消", "通常属于履约前取消，不计入真实销售和真实亏损。", 21, "真实样本：买家发起取消请求"],
    ["库存售罄", "товар закончился на складе", "contains", "卖家", "库存售罄", "out_of_stock", "缺货", "通常属于履约前取消，不计入真实销售和真实亏损。", 22, "真实样本：库存用尽"],
    ["商品损坏", "товар поврежден", "contains", "物流", "商品损坏", "damaged_in_delivery", "物流破损", "通常属于已履约异常，需要核对平台责任和真实损失归属。", 23, "真实样本：配送过程损坏"],
    ["平台描述核验", "соответствие описанию", "contains", "平台", "平台描述核验", "quality_inspection", "质检/平台核验", "通常不作为正常销售，也不应直接按用户退货损失处理。", 24, "真实高频：平台描述核验"]
  ];
  const exists = db.prepare("SELECT id FROM order_cancellation_rules WHERE name = ? LIMIT 1");
  const insert = db.prepare(`
    INSERT INTO order_cancellation_rules
    (name, match_text, match_mode, initiator_label, reason_label, reason_code, reason_group_label, accounting_hint, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const rule of defaults) {
    if (exists.get(rule[0])) continue;
    insert.run(...rule);
  }
}

function repairCorruptedOrderCancellationRules() {
  const updates = [
    [21, "商品不合适", "товар не подошел", "", "商品不合适", "商品不适配"],
    [22, "发错货/货不对版", "в заказе не тот товар", "卖家", "发错货", "发错货/错配"],
    [23, "平台配送失败", "не удалось доставить заказ", "平台", "配送失败", "配送失败/妥投失败"],
    [24, "卖家取消订单", "вы отменили заказ", "卖家", "卖家取消", "卖家取消"]
  ];
  const stmt = db.prepare(`
    UPDATE order_cancellation_rules
    SET name = ?, match_text = ?, initiator_label = ?, reason_label = ?, reason_group_label = ?
    WHERE id = ?
      AND (
        name GLOB '*?*'
        OR match_text GLOB '*?*'
        OR reason_label GLOB '*?*'
        OR reason_group_label GLOB '*?*'
        OR initiator_label GLOB '*?*'
      )
  `);
  for (const [id, name, matchText, initiatorLabel, reasonLabel, reasonGroupLabel] of updates) {
    stmt.run(name, matchText, initiatorLabel, reasonLabel, reasonGroupLabel, id);
  }
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

function cleanupRecursiveProductImageUrls() {
  db.exec(`
    UPDATE products
    SET image_url = ''
    WHERE image_url GLOB '/api/products/*/image';
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

cleanupRecursiveProductImageUrls();

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
