export const CUSTOMER_MESSAGE_SHOP_SCHEMA = `
    CREATE TABLE IF NOT EXISTS customer_message_shop_settings (
      shop_id INT NOT NULL PRIMARY KEY,
      automation_person_id BIGINT NULL,
      chat_enabled TINYINT(1) NOT NULL DEFAULT 0,
      send_mode VARCHAR(32) NOT NULL DEFAULT 'draft',
      chat_capability VARCHAR(32) NOT NULL DEFAULT 'unchecked',
      chat_capability_checked_at DATETIME NULL,
      chat_capability_error TEXT NULL,
      automation_defaults_version INT NOT NULL DEFAULT 1,
      stall_hours INT NOT NULL DEFAULT 36,
      delay_hours_before_due INT NOT NULL DEFAULT 24,
      pickup_delay_hours INT NOT NULL DEFAULT 1,
      review_delay_hours INT NOT NULL DEFAULT 12,
      pickup_automation_enabled_at DATETIME NULL,
      review_automation_enabled_at DATETIME NULL,
      passport_automation_enabled_at DATETIME NULL,
      enabled_scenarios TEXT NULL,
      note TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;

export const CUSTOMER_MESSAGE_TASKS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS customer_message_tasks (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT NOT NULL,
      posting_number VARCHAR(128) NOT NULL DEFAULT '',
      shop_id INT NOT NULL,
      person_id BIGINT NULL,
      scenario VARCHAR(64) NOT NULL,
      reminder_step INT NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      scheduled_at DATETIME NOT NULL,
      next_attempt_at DATETIME NOT NULL,
      sent_at DATETIME NULL,
      cancelled_at DATETIME NULL,
      attempts INT NOT NULL DEFAULT 0,
      chat_id VARCHAR(128) NOT NULL DEFAULT '',
      message_text TEXT NULL,
      last_error TEXT NULL,
      cancel_reason VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_customer_message_task (shop_id, order_id, scenario, reminder_step),
      KEY idx_customer_message_task_due (status, next_attempt_at),
      KEY idx_customer_message_task_order (order_id, scenario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
