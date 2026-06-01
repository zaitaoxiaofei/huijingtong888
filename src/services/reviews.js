import { createOzonReviewComment, fetchOzonReviewComments, fetchOzonReviews } from "../ozonClient.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

let reviewSchemaReady = false;

async function ensureReviewSchema() {
  if (reviewSchemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ozon_reviews (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      shop_id BIGINT UNSIGNED NOT NULL,
      review_id VARCHAR(191) NOT NULL,
      ozon_sku VARCHAR(128) NULL,
      offer_id VARCHAR(255) NULL,
      ozon_product_id VARCHAR(128) NULL,
      product_name VARCHAR(512) NULL,
      product_image TEXT NULL,
      rating INT NOT NULL DEFAULT 0,
      status VARCHAR(64) NOT NULL DEFAULT '',
      review_text TEXT NULL,
      advantages TEXT NULL,
      disadvantages TEXT NULL,
      has_reply TINYINT(1) NOT NULL DEFAULT 0,
      reply_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      reply_text TEXT NULL,
      replied_at DATETIME NULL,
      published_at DATETIME NULL,
      ozon_updated_at DATETIME NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json LONGTEXT NULL,
      UNIQUE KEY uk_ozon_reviews_shop_review (shop_id, review_id),
      KEY idx_ozon_reviews_shop_status (shop_id, reply_status, rating),
      KEY idx_ozon_reviews_published (published_at, id),
      KEY idx_ozon_reviews_sku (shop_id, ozon_sku)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ozon_review_replies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      review_local_id BIGINT UNSIGNED NOT NULL,
      shop_id BIGINT UNSIGNED NOT NULL,
      review_id VARCHAR(191) NOT NULL,
      comment_id VARCHAR(191) NULL,
      reply_text TEXT NOT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'manual',
      status VARCHAR(32) NOT NULL DEFAULT 'sent',
      created_by_person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json LONGTEXT NULL,
      KEY idx_review_replies_review (review_local_id, created_at),
      KEY idx_review_replies_shop_review (shop_id, review_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ozon_review_reply_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      template_text TEXT NOT NULL,
      min_rating INT NULL,
      max_rating INT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const rows = await mysqlQuery("SELECT COUNT(*) AS total FROM ozon_review_reply_templates");
  if (!Number(rows?.[0]?.total || 0)) {
    await mysqlExecute(`
      INSERT INTO ozon_review_reply_templates (title, template_text, min_rating, max_rating) VALUES
      ('好评感谢', 'Спасибо за ваш отзыв! Будем рады видеть вас снова.', 4, 5),
      ('普通评价', 'Спасибо за обратную связь. Мы обязательно учтем ваши замечания.', 3, 3),
      ('差评安抚', 'Спасибо за отзыв. Нам очень жаль, что товар не полностью оправдал ожидания. Мы передадим информацию команде и постараемся улучшить качество.', 1, 2)
    `);
  }
  reviewSchemaReady = true;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace("T", " ");
}

function shopCredentialsSelect() {
  return "id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint";
}

async function shopsForSync(shopId) {
  const params = [];
  let where = "status <> 'deleted'";
  if (shopId && String(shopId) !== "all") {
    where += " AND id = ?";
    params.push(Number(shopId));
  }
  return mysqlQuery(`SELECT ${shopCredentialsSelect()} FROM shops WHERE ${where} ORDER BY id`, params);
}

async function upsertReview(shop, review) {
  if (!review.review_id) return false;
  const replyStatus = review.has_reply ? "replied" : "pending";
  await mysqlExecute(`
    INSERT INTO ozon_reviews (
      shop_id, review_id, ozon_sku, offer_id, ozon_product_id, product_name, product_image,
      rating, status, review_text, advantages, disadvantages, has_reply, reply_status,
      published_at, ozon_updated_at, synced_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    ON DUPLICATE KEY UPDATE
      ozon_sku = VALUES(ozon_sku),
      offer_id = VALUES(offer_id),
      ozon_product_id = VALUES(ozon_product_id),
      product_name = VALUES(product_name),
      product_image = VALUES(product_image),
      rating = VALUES(rating),
      status = VALUES(status),
      review_text = VALUES(review_text),
      advantages = VALUES(advantages),
      disadvantages = VALUES(disadvantages),
      has_reply = VALUES(has_reply),
      reply_status = IF(reply_status = 'replied', reply_status, VALUES(reply_status)),
      published_at = VALUES(published_at),
      ozon_updated_at = VALUES(ozon_updated_at),
      synced_at = NOW(),
      raw_json = VALUES(raw_json)
  `, [
    shop.id,
    review.review_id,
    review.ozon_sku || "",
    review.offer_id || "",
    review.ozon_product_id || "",
    review.product_name || "",
    review.product_image || "",
    Number(review.rating || 0),
    review.status || "",
    review.text || "",
    review.advantages || "",
    review.disadvantages || "",
    review.has_reply ? 1 : 0,
    replyStatus,
    dateOrNull(review.published_at),
    dateOrNull(review.updated_at),
    review.raw_json || "{}"
  ]);
  return true;
}

export async function reviewCenterMysql(query = {}) {
  await ensureReviewSchema();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(Math.max(Number(query.pageSize || 30), 1), 100);
  const where = [];
  const params = [];
  if (query.shopId && String(query.shopId) !== "all") {
    where.push("r.shop_id = ?");
    params.push(Number(query.shopId));
  }
  if (query.replyStatus && String(query.replyStatus) !== "all") {
    where.push("r.reply_status = ?");
    params.push(String(query.replyStatus));
  }
  if (query.rating && String(query.rating) !== "all") {
    where.push("r.rating = ?");
    params.push(Number(query.rating));
  }
  const keyword = String(query.keyword || "").trim().toLowerCase();
  if (keyword) {
    where.push("LOWER(CONCAT(COALESCE(r.product_name, ''), ' ', COALESCE(r.ozon_sku, ''), ' ', COALESCE(r.offer_id, ''), ' ', COALESCE(r.review_text, ''))) LIKE ?");
    params.push(`%${keyword}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRows = await mysqlQuery(`SELECT COUNT(*) AS total FROM ozon_reviews r ${whereSql}`, params);
  const rows = await mysqlQuery(`
    SELECT r.*, s.name AS shop_name
    FROM ozon_reviews r
    JOIN shops s ON s.id = r.shop_id
    ${whereSql}
    ORDER BY COALESCE(r.published_at, r.synced_at) DESC, r.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, (page - 1) * pageSize]);
  return { rows, total: Number(countRows?.[0]?.total || 0), page, pageSize };
}

export async function syncOzonReviewsMysql(body = {}, options = {}) {
  await ensureReviewSchema();
  const shops = await shopsForSync(body.shop_id || body.shopId);
  const result = { shops: [], fetched: 0, upserted: 0, requests: 0, errors: [] };
  for (const shop of shops) {
    try {
      const response = await fetchOzonReviews(shop, {
        status: body.status || "",
        limit: body.limit || 100,
        maxPages: body.maxPages || 3,
        signal: options.signal
      });
      let upserted = 0;
      for (const review of response.reviews) {
        const ok = await upsertReview(shop, review);
        if (ok) upserted += 1;
      }
      result.fetched += response.reviews.length;
      result.upserted += upserted;
      result.requests += response.requests || 0;
      result.shops.push({ shop_id: shop.id, shop_name: shop.name, fetched: response.reviews.length, upserted });
    } catch (error) {
      const message = friendlyOzonReviewError(error);
      result.errors.push(`${shop.name}: ${message}`);
      result.shops.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, upserted: 0, error: message });
    }
  }
  return result;
}

export async function replyOzonReviewMysql(id, body = {}, personId = null) {
  await ensureReviewSchema();
  const rows = await mysqlQuery(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM ozon_reviews r
    JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  const review = rows[0];
  if (!review) throw new Error("评价不存在");
  const text = String(body.reply_text || body.text || "").trim();
  if (!text) throw new Error("回复内容不能为空");
  const response = await createOzonReviewComment(review, review.review_id, text);
  const commentId = String(response?.result?.comment_id || response?.comment_id || "");
  await mysqlExecute(`
    UPDATE ozon_reviews
    SET reply_status = 'replied', reply_text = ?, has_reply = 1, replied_at = NOW()
    WHERE id = ?
  `, [text, Number(id)]);
  await mysqlExecute(`
    INSERT INTO ozon_review_replies (review_local_id, shop_id, review_id, comment_id, reply_text, source, status, created_by_person_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)
  `, [
    Number(id),
    review.shop_id,
    review.review_id,
    commentId,
    text,
    body.source || "manual",
    personId || null,
    JSON.stringify(response || {})
  ]);
  return { ok: true, comment_id: commentId, demo: Boolean(response?.demo) };
}

export async function reviewReplyTemplatesMysql() {
  await ensureReviewSchema();
  return mysqlQuery("SELECT * FROM ozon_review_reply_templates WHERE active = 1 ORDER BY min_rating DESC, id ASC");
}

export async function reviewCommentsMysql(id) {
  await ensureReviewSchema();
  const rows = await mysqlQuery(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM ozon_reviews r
    JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  const review = rows[0];
  if (!review) return [];
  return fetchOzonReviewComments(review, review.review_id);
}

function friendlyOzonReviewError(error) {
  const message = String(error?.message || error || "");
  if (/not available with existing subscription|PermissionDenied/i.test(message)) {
    return "Ozon 当前店铺订阅不支持评价 API，请在 Ozon 后台开通支持评价接口的订阅/权限后再同步。";
  }
  if (/ReviewListRequest\.Limit/i.test(message)) {
    return "Ozon 评价接口要求每页数量在 20-100 之间，请刷新页面后重试。";
  }
  return message || "同步失败";
}
