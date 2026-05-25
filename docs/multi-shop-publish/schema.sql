-- 多店铺商品发布中台 MySQL 表结构
-- 设计原则：
-- 1. 母商品保存稳定的商品事实和原始素材。
-- 2. 店铺商品版本保存面向店铺的标题、价格、库存、图片、水印和发布载荷。
-- 3. 发布任务和任务明细分离，便于批量发布、失败重试、状态追踪。
-- 4. 图片生成、AI 素材、数据看板均可独立扩展，不阻塞 Ozon API 接入。

CREATE TABLE IF NOT EXISTS master_products (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_code VARCHAR(128) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  category VARCHAR(255) NOT NULL DEFAULT '',
  vehicle_models VARCHAR(500) NOT NULL DEFAULT '',
  brand VARCHAR(128) NOT NULL DEFAULT '',
  material VARCHAR(128) NOT NULL DEFAULT '',
  cost_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  default_sale_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_quantity INT NOT NULL DEFAULT 0,
  description LONGTEXT NULL,
  status ENUM('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_master_products_code (product_code),
  KEY idx_master_products_status (status, updated_at),
  KEY idx_master_products_category (category)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_assets (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  master_product_id BIGINT NOT NULL,
  asset_type ENUM('raw','main','detail','scene','handheld','closeup','value','generated') NOT NULL DEFAULT 'raw',
  url TEXT NOT NULL,
  storage_path TEXT NULL,
  file_name VARCHAR(255) NOT NULL DEFAULT '',
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  source_type ENUM('upload','ai','watermark','ozon','external') NOT NULL DEFAULT 'upload',
  metadata_json JSON NULL,
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_product_assets_product (master_product_id, asset_type, sort_order),
  CONSTRAINT fk_product_assets_master_product FOREIGN KEY (master_product_id) REFERENCES master_products(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_watermark_templates (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  logo_url TEXT NOT NULL,
  logo_path TEXT NULL,
  position ENUM('top-left','top-right','bottom-left','bottom-right','bottom-center') NOT NULL DEFAULT 'bottom-right',
  opacity DECIMAL(4,2) NOT NULL DEFAULT 0.82,
  size_percent DECIMAL(5,2) NOT NULL DEFAULT 22.00,
  margin_px INT NOT NULL DEFAULT 24,
  status ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active',
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_watermark_templates_status (status, updated_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_shops (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  shop_name VARCHAR(128) NOT NULL,
  platform ENUM('ozon','wildberries','yandex','other') NOT NULL DEFAULT 'ozon',
  logo_url TEXT NULL,
  watermark_template_id BIGINT NULL,
  api_client_id VARCHAR(255) NOT NULL DEFAULT '',
  api_key_cipher TEXT NULL,
  api_config_json JSON NULL,
  status ENUM('active','paused','disabled','deleted') NOT NULL DEFAULT 'active',
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_sales_shops_platform_status (platform, status),
  CONSTRAINT fk_sales_shops_watermark FOREIGN KEY (watermark_template_id) REFERENCES shop_watermark_templates(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_product_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  master_product_id BIGINT NOT NULL,
  shop_id BIGINT NOT NULL,
  offer_id VARCHAR(128) NOT NULL DEFAULT '',
  title VARCHAR(500) NOT NULL DEFAULT '',
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_quantity INT NOT NULL DEFAULT 0,
  description LONGTEXT NULL,
  main_image_asset_id BIGINT NULL,
  watermark_template_id BIGINT NULL,
  image_plan ENUM('use_master_main','first_raw','shop_specific','manual') NOT NULL DEFAULT 'use_master_main',
  generated_images_json JSON NULL,
  ozon_payload_json JSON NULL,
  validation_json JSON NULL,
  status ENUM('draft','generated','previewed','task_created','published','failed','archived') NOT NULL DEFAULT 'draft',
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shop_product_versions (master_product_id, shop_id, offer_id),
  KEY idx_shop_versions_product (master_product_id, status),
  KEY idx_shop_versions_shop (shop_id, status),
  CONSTRAINT fk_shop_versions_product FOREIGN KEY (master_product_id) REFERENCES master_products(id),
  CONSTRAINT fk_shop_versions_shop FOREIGN KEY (shop_id) REFERENCES sales_shops(id),
  CONSTRAINT fk_shop_versions_watermark FOREIGN KEY (watermark_template_id) REFERENCES shop_watermark_templates(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS publish_tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_no VARCHAR(64) NOT NULL,
  master_product_id BIGINT NOT NULL,
  total_count INT NOT NULL DEFAULT 0,
  pending_count INT NOT NULL DEFAULT 0,
  processing_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  status ENUM('pending','processing','partial_success','success','failed','cancelled') NOT NULL DEFAULT 'pending',
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_publish_tasks_no (task_no),
  KEY idx_publish_tasks_product (master_product_id, created_at),
  KEY idx_publish_tasks_status (status, updated_at),
  CONSTRAINT fk_publish_tasks_product FOREIGN KEY (master_product_id) REFERENCES master_products(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS publish_task_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id BIGINT NOT NULL,
  shop_product_version_id BIGINT NOT NULL,
  shop_id BIGINT NOT NULL,
  offer_id VARCHAR(128) NOT NULL DEFAULT '',
  status ENUM('pending','publishing','success','failed','cancelled') NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  ozon_task_id VARCHAR(128) NOT NULL DEFAULT '',
  ozon_product_id VARCHAR(128) NOT NULL DEFAULT '',
  ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
  product_url TEXT NULL,
  request_json JSON NULL,
  response_json JSON NULL,
  error_message TEXT NULL,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_publish_items_task (task_id, status),
  KEY idx_publish_items_shop (shop_id, status),
  CONSTRAINT fk_publish_items_task FOREIGN KEY (task_id) REFERENCES publish_tasks(id),
  CONSTRAINT fk_publish_items_version FOREIGN KEY (shop_product_version_id) REFERENCES shop_product_versions(id),
  CONSTRAINT fk_publish_items_shop FOREIGN KEY (shop_id) REFERENCES sales_shops(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_image_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  master_product_id BIGINT NULL,
  source_asset_id BIGINT NULL,
  image_type ENUM('main','detail','scene','handheld','closeup','value') NOT NULL,
  vehicle_model VARCHAR(255) NOT NULL DEFAULT '',
  product_type VARCHAR(255) NOT NULL DEFAULT '',
  prompt_template_key VARCHAR(128) NOT NULL DEFAULT '',
  prompt_text LONGTEXT NOT NULL,
  provider VARCHAR(64) NOT NULL DEFAULT 'openai',
  status ENUM('pending','generating','success','failed') NOT NULL DEFAULT 'pending',
  result_assets_json JSON NULL,
  error_message TEXT NULL,
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ai_image_jobs_product (master_product_id, status, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_product_daily_metrics (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  metric_date DATE NOT NULL,
  master_product_id BIGINT NOT NULL,
  shop_id BIGINT NOT NULL,
  shop_product_version_id BIGINT NULL,
  main_image_asset_id BIGINT NULL,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  ctr DECIMAL(8,4) NOT NULL DEFAULT 0,
  orders INT NOT NULL DEFAULT 0,
  conversion_rate DECIMAL(8,4) NOT NULL DEFAULT 0,
  revenue DECIMAL(14,2) NOT NULL DEFAULT 0,
  raw_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shop_product_metrics (metric_date, master_product_id, shop_id, shop_product_version_id),
  KEY idx_metrics_product_date (master_product_id, metric_date),
  KEY idx_metrics_shop_date (shop_id, metric_date),
  CONSTRAINT fk_metrics_product FOREIGN KEY (master_product_id) REFERENCES master_products(id),
  CONSTRAINT fk_metrics_shop FOREIGN KEY (shop_id) REFERENCES sales_shops(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
