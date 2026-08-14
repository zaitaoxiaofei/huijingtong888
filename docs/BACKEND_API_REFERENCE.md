# Ozon ERP Backend API Reference

Generated from code metadata at `SOURCE_CONTROLLED`.

## Conventions

- All endpoints live in the native Node.js HTTP server and return JSON unless the media type says otherwise.
- Authenticated endpoints require an Authorization header with a Bearer token from /api/auth/login.
- Every endpoint contract is maintained in src/server/api-docs.js as the single source of truth.
- Unexpected failures return the standard ErrorResponse payload with HTTP status 4xx or 5xx.

## T0 API Change Policy

Tier: `T0`

Mandatory rules:
- Any backend endpoint behavior change is a T0 system change.
- The endpoint definition in src/server/api-docs.js must be updated in the same change set.
- The generated file docs/BACKEND_API_REFERENCE.md must be regenerated in the same change set.
- Request schema, path params, query params, response schema, and auth mode must stay synchronized.
- If a response shape changes, the reusable schema entry must be updated instead of leaving drift in prose.

Enforcement:
- Run npm run docs:api after changing backend routes or service contracts.
- Run npm run docs:api:check before merge to ensure the committed Markdown matches generated output.
- Code review should reject API changes that do not update both the registry and the generated Markdown.
- Development tracker entries for system-level work must record this requirement as T0.

## Schemas

### ApiCatalog

Machine-readable API contract catalog.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `generatedAt` | `string` | Yes | Generation timestamp in ISO-8601. |
| `title` | `string` | Yes | Catalog title. |
| `overview` | `array<string>` | Yes | Shared conventions. |
| `changePolicy` | `ApiChangePolicy` | Yes | Mandatory change-management policy. |
| `schemas` | `object` | Yes | Named reusable schema registry. |
| `sections` | `array<object>` | Yes | Endpoint groups. |

### ApiChangePolicy

System-level API documentation governance policy.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tier` | `string` | Yes | Operational severity level. Current value is T0. |
| `title` | `string` | Yes | Policy title. |
| `requirements` | `array<string>` | Yes | Mandatory rules for API changes. |
| `enforcement` | `array<string>` | Yes | Enforcement steps. |

### ErrorResponse

Standard JSON error payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | `string` | Yes | Human-readable error message. |

### MutationOk

Minimal mutation success payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `boolean` | Yes | Whether the operation completed successfully. |

### IdResponse

Creation success payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | Newly created record identifier. |

### AuthUser

Authenticated ERP user.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | Internal person identifier. |
| `name` | `string` | Yes | Display name. |
| `role` | `string` | Yes | Authorization role such as admin or operator. |
| `username` | `string` | Yes | Login username. |

### AuthSession

Login response for token-based API access.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `boolean` | Yes | Whether login succeeded. |
| `token` | `string` | Yes | Bearer token for later Authorization headers. |
| `user` | `AuthUser` | Yes | Authenticated user. |

### LoginRequest

Login payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `username` | `string` | Yes | Username to authenticate. |
| `password` | `string` | Yes | Plain-text password. |

### ChangePasswordRequest

Password change payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `old_password` | `string` | Yes | Current password. |
| `new_password` | `string` | Yes | New password. |

### SystemInfo

Runtime information about the current ERP instance.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `appVersion` | `string` | No | Application version or release marker. |
| `dbClient` | `string` | No | Active database client. |
| `database` | `object` | No | Active MySQL database connection summary. |
| `host` | `string` | No | Server bind host. |
| `port` | `number` | No | Server bind port. |
| `appBaseUrl` | `string` | No | Browser-facing base URL. |

### ScheduledJob

Persisted background task schedule and latest execution state.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Scheduled job identifier. |
| `key` | `string` | No | Stable job key such as order_status_sync. |
| `name` | `string` | No | Human-readable job name. |
| `category` | `string` | No | Job category such as orders, advertising, inventory, listing, analytics, or maintenance. |
| `priority` | `string` | No | Execution priority such as critical, high, normal, or low. |
| `scheduleType` | `string` | No | Schedule type: interval or daily. |
| `intervalMinutes` | `number` | No | Interval in minutes for interval jobs. |
| `dailyTime` | `string` | No | Shanghai wall-clock time for daily jobs, HH:mm. |
| `enabled` | `boolean` | No | Whether the scheduler may run this job. |
| `catchupEnabled` | `boolean` | No | Whether missed runs may be recovered after downtime. |
| `config` | `object` | No | Optional task-specific runtime config such as timeout minutes or sync scope. |
| `lastSuccessAt` | `string` | No | Last successful run timestamp. |
| `lastAttemptAt` | `string` | No | Last attempted run timestamp. |
| `nextRunAt` | `string` | No | Next planned run timestamp. |
| `failCount` | `number` | No | Consecutive failure count. |
| `lastStatus` | `string` | No | Latest run status. |
| `lastError` | `string` | No | Latest error message, if any. |
| `recentRuns` | `array<ScheduledJobRun>` | No | Most recent run rows for this job. |

### ScheduledJobRun

One background task execution record.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Run identifier. |
| `jobKey` | `string` | No | Scheduled job key. |
| `plannedFor` | `string` | No | Planned execution timestamp. |
| `startedAt` | `string` | No | Run start timestamp. |
| `finishedAt` | `string` | No | Run finish timestamp. |
| `status` | `string` | No | Run status: running, success, partial, failed, or skipped. |
| `mode` | `string` | No | Run source such as scheduled, manual, or catchup. |
| `payload` | `object` | No | Schedule payload captured when the run started. |
| `result` | `object` | No | Handler result payload for successful or skipped runs. |
| `errorMessage` | `string` | No | Failure message, if any. |

### ScheduledJobRunRequest

Manual scheduled-job run request.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_key` | `string` | Yes | Scheduled job key to run immediately. |

### ScheduledJobStateRequest

Scheduled-job enable or disable request.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_key` | `string` | Yes | Scheduled job key to update. |
| `enabled` | `boolean` | Yes | Whether the job should be enabled. |

### ScheduledJobConfigRequest

Scheduled-job runtime configuration update request.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_key` | `string` | Yes | Scheduled job key to update. |
| `scheduleType` | `string` | No | Schedule type: interval or daily. |
| `intervalMinutes` | `number` | No | Interval in minutes for interval jobs. |
| `dailyTime` | `string` | No | Shanghai wall-clock time for daily jobs, HH:mm. |
| `catchupEnabled` | `boolean` | No | Whether missed runs may be recovered after downtime. |
| `maxCatchupRuns` | `number` | No | Maximum backfill runs allowed when recovering. |
| `config` | `object` | No | Task-specific config patch such as timeout minutes, scope, or days. |

### ExchangeRate

CNY to RUB exchange-rate row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Rate record identifier. |
| `currency_from` | `string` | No | Base currency code. |
| `currency_to` | `string` | No | Target currency code. |
| `rate` | `number` | No | Conversion rate. |
| `source` | `string` | No | Rate source such as manual or fallback. |
| `effective_date` | `string` | No | Date when the rate becomes effective. |
| `note` | `string` | No | Operator note. |

### ExchangeRateUpdateRequest

Create a manual exchange rate record.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rate` | `number` | Yes | New positive conversion rate. |
| `source` | `string` | No | Optional source label such as manual. |
| `effective_date` | `string` | No | Optional effective date in YYYY-MM-DD. |
| `note` | `string` | No | Optional note. |

### ShopRecord

ERP shop configuration row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Shop identifier. |
| `name` | `string` | No | Shop display name. |
| `legal_entity` | `string` | No | Legacy legal entity or company name. |
| `user_id` | `number` | No | Bound shop manager person identifier. |
| `user_name` | `string` | No | Bound shop manager display name. |
| `ozon_client_id` | `string` | No | Ozon client identifier. |
| `api_key_hint` | `string` | No | Non-sensitive API key hint. |
| `status` | `string` | No | Shop status. |
| `payout_rate` | `number` | No | Settlement payout ratio. |
| `created_at` | `string` | No | Creation timestamp. |

### ShopMutationRequest

Create or update shop payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Shop display name. |
| `legal_entity` | `string` | No | Legacy legal entity or company name. |
| `user_id` | `number` | No | Required shop manager person identifier. |
| `ozon_client_id` | `string` | No | Ozon client identifier. |
| `api_key_hint` | `string` | No | Displayed API key hint only. |
| `status` | `string` | No | Shop status such as active or inactive. |
| `payout_rate` | `number` | No | Settlement payout ratio. |

### PersonRecord

ERP person or operator record.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Person identifier. |
| `name` | `string` | No | Display name. |
| `username` | `string` | No | Login username. |
| `role` | `string` | No | Authorization role. |
| `avatar_url` | `string` | No | Optional avatar URL. |
| `active` | `number` | No | Whether the person is active. |

### PersonMutationRequest

Create or update person payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Display name. |
| `username` | `string` | No | Login username. |
| `password` | `string` | No | Optional initial password for creation or reset. |
| `role` | `string` | No | Authorization role such as operator or admin. |
| `avatar_url` | `string` | No | Optional avatar URL. |
| `active` | `number` | No | Whether the person is active. |

### TeamTaskRecord

Team planning task row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Task identifier. |
| `title` | `string` | No | Task title. |
| `type` | `string` | No | Work type such as collection, selection, fission, draft, listing, vehicle_sales, order_review, procurement, or optimization. Legacy values advertising, finance_tax, and warehouse are still accepted. |
| `owner_person_id` | `number` | No | Responsible person identifier. |
| `owner_name` | `string` | No | Responsible person display name. |
| `owner_avatar_url` | `string` | No | Responsible person avatar URL. |
| `collaborator_person_ids` | `array<number>` | No | Collaborator person identifiers. |
| `period` | `string` | No | Planning period such as week, month, quarter, or year. |
| `status` | `string` | No | Task status. |
| `priority` | `string` | No | Task priority. |
| `target` | `number` | No | Target quantity. |
| `done` | `number` | No | Completed quantity. |
| `unit` | `string` | No | Quantity unit. |
| `start_at` | `string` | No | Start date. |
| `due_at` | `string` | No | Due date. |
| `related` | `string` | No | Related shop, product line, SKU, purchase order, or warehouse. |
| `result` | `string` | No | Operator progress note. |
| `quality` | `number` | No | Quality score from 0 to 100. |

### TeamTaskMutationRequest

Create or update team planning task payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Task title. |
| `type` | `string` | No | Work type. |
| `owner_person_id` | `number` | No | Responsible person identifier. |
| `collaborator_person_ids` | `array<number>` | No | Collaborator person identifiers. |
| `period` | `string` | No | Planning period. |
| `status` | `string` | No | Task status. |
| `priority` | `string` | No | Task priority. |
| `target` | `number` | No | Target quantity. |
| `done` | `number` | No | Completed quantity. |
| `unit` | `string` | No | Quantity unit. |
| `start_at` | `string` | No | Start date in YYYY-MM-DD. |
| `due_at` | `string` | No | Due date in YYYY-MM-DD. |
| `related` | `string` | No | Related business object. |
| `result` | `string` | No | Progress note. |

### SupplierRecord

Supplier master-data row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Supplier identifier. |
| `name` | `string` | No | Supplier name. |
| `contact_person` | `string` | No | Primary contact person. |
| `contact_phone` | `string` | No | Primary contact phone. |
| `wechat_id` | `string` | No | WeChat identifier. |
| `business_note` | `string` | No | Business note. |
| `status` | `string` | No | Supplier status. |
| `product_count` | `number` | No | Number of active linked products. |

### SupplierMutationRequest

Create or update supplier payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Supplier name. |
| `contact_person` | `string` | No | Primary contact person. |
| `contact_phone` | `string` | No | Primary contact phone. |
| `wechat_id` | `string` | No | WeChat identifier. |
| `business_note` | `string` | No | Business note. |

### ProductRecord

Selection or inventory product with computed business metrics.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Product identifier. |
| `selection_id` | `string` | No | Legacy selection identifier. |
| `code` | `string` | No | Stable internal product code. |
| `inventory_id` | `string` | No | Derived display inventory code. |
| `name` | `string` | No | Product name. |
| `image_url` | `string` | No | Product image URL or data URI. |
| `purchase_url` | `string` | No | Procurement link. |
| `shipping_method` | `string` | No | Preferred shipping method. |
| `purchase_cost` | `number` | No | Unit purchase cost. |
| `owner_person_id` | `number` | No | Assigned owner identifier. |
| `owner_name` | `string` | No | Assigned owner display name. |
| `supplier_id` | `number` | No | Linked supplier identifier. |
| `stock` | `number` | No | Posted local stock balance. |
| `incoming_stock` | `number` | No | Expected inbound stock. |
| `avg_unit_cost` | `number` | No | Average unit cost. |
| `avg_sale_price` | `number` | No | Average realized sale price. |
| `avg_profit` | `number` | No | Average estimated profit per sold unit. |
| `estimated_profit_total` | `number` | No | Total estimated profit for sold items. |
| `actual_profit_total` | `number` | No | Total accrued actual profit for sold items. |
| `profit_rate` | `number` | No | Average profit ratio. |
| `order_count` | `number` | No | Distinct order count. |
| `sku_count` | `number` | No | Count of active mapped SKUs. |
| `mapped_skus` | `string` | No | Comma-separated mapped Ozon SKUs. |
| `active` | `number` | No | Whether the product is active. |
| `created_at` | `string` | No | Creation timestamp. |
| `updated_at` | `string` | No | Last update timestamp. |

### ProductMutationRequest

Create or update product payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `selection_id` | `string` | No | Optional legacy selection identifier. |
| `code` | `string` | No | Stable internal product code. |
| `name` | `string` | Yes | Product name. |
| `image_url` | `string` | No | Product image URL or data URI. |
| `purchase_url` | `string` | No | Procurement link. |
| `supplier_note` | `string` | No | Supplier note. |
| `source_platform` | `string` | No | Procurement source platform. |
| `shipping_method` | `string` | No | Preferred shipping method. |
| `recommended_shipping_method` | `string` | No | Recommended shipping method. |
| `purchase_cost` | `number` | No | Unit purchase cost. |
| `domestic_shipping` | `number` | No | Domestic shipping cost. |
| `handling_fee` | `number` | No | Handling or packaging fee. |
| `purchase_quantity` | `number` | No | Recommended procurement quantity. |
| `package_weight_g` | `number` | No | Package weight in grams. |
| `length_cm` | `number` | No | Package length in centimeters. |
| `width_cm` | `number` | No | Package width in centimeters. |
| `height_cm` | `number` | No | Package height in centimeters. |
| `listing_price_rub` | `number` | No | Suggested listing price in RUB. |
| `air_sale_price_rmb` | `number` | No | Reference sale price in RMB. |
| `exchange_rate` | `number` | No | Reference exchange rate. |
| `target_margin` | `number` | No | Target margin ratio. |
| `desired_profit_mode` | `string` | No | Desired profit mode. |
| `desired_profit_value` | `number` | No | Desired profit value. |
| `return_rate` | `number` | No | Expected return rate. |
| `payment_fee_rate` | `number` | No | Payment fee rate. |
| `withdrawal_fee_rate` | `number` | No | Withdrawal fee rate. |
| `owner_person_id` | `number` | No | Assigned owner identifier. |
| `created_by_person_id` | `number` | No | Creator identifier. |
| `product_type` | `string` | No | Product type such as main or accessory. |
| `parent_product_id` | `number` | No | Parent product identifier. |
| `accessory_note` | `string` | No | Accessory note. |
| `selection_status` | `string` | No | Selection lifecycle status. |
| `alert_stock` | `number` | No | Local stock warning threshold. |
| `supplier_id` | `number` | No | Linked supplier identifier. |
| `active` | `number` | No | Whether the product is active. |

### ProductCreateResponse

Product creation response.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | New product identifier. |
| `product` | `ProductRecord` | Yes | Enriched product detail after creation. |

### ProductImportPreviewRequest

Product CSV import preview payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `csv_text` | `string` | Yes | Raw CSV content. |
| `delimiter` | `string` | No | Optional CSV delimiter override. |

### ProductImportPreviewResponse

Import preview result.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rows` | `array<object>` | Yes | Parsed rows. |
| `errors` | `array<object>` | Yes | Validation issues. |

### ProductImportCommitRequest

Commit a validated product import batch.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rows` | `array<object>` | Yes | Rows to persist. |

### OnlineProductRecord

Ozon online product or SKU snapshot.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Online product identifier. |
| `shop_id` | `number` | No | Owning shop identifier. |
| `product_id` | `number` | No | Linked ERP product identifier. |
| `ozon_sku` | `string` | No | Ozon SKU. |
| `offer_id` | `string` | No | Seller offer identifier. |
| `name` | `string` | No | Product title from Ozon. |
| `image_url` | `string` | No | Image URL. |
| `primary_image` | `string` | No | Primary image URL. |
| `sale_price` | `number` | No | Current sale price. |
| `currency_code` | `string` | No | Price currency code. |
| `status` | `string` | No | Lifecycle status on Ozon. |
| `visibility` | `string` | No | Storefront visibility state. |
| `archived` | `number` | No | Whether the item is archived. |
| `is_discounted` | `number` | No | Whether the item is discounted. |
| `synced_at` | `string` | No | Last synchronization timestamp. |
| `updated_at` | `string` | No | Last local update timestamp. |

### OnlineProductMutationRequest

Create or update a local online-product record.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `shop_id` | `number` | Yes | Owning shop identifier. |
| `ozon_sku` | `string` | Yes | Ozon SKU. |
| `offer_id` | `string` | No | Seller offer identifier. |
| `name` | `string` | Yes | Product title. |
| `image_url` | `string` | No | Image URL. |
| `primary_image` | `string` | No | Primary image URL. |
| `sale_price` | `number` | No | Current sale price. |
| `currency_code` | `string` | No | Price currency code. |
| `status` | `string` | No | Lifecycle status. |
| `visibility` | `string` | No | Storefront visibility state. |
| `archived` | `number` | No | Whether the item is archived. |
| `is_discounted` | `number` | No | Whether the item is discounted. |
| `product_id` | `number` | No | Linked ERP product identifier. |

### OnlineProductBindRequest

Bind an online product to ERP inventory ownership.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `online_product_id` | `number` | Yes | Local online product identifier. |
| `product_id` | `number` | Yes | ERP product identifier. |
| `person_id` | `number` | No | Responsible owner identifier. |
| `shop_id` | `number` | No | Shop identifier. |
| `ozon_sku` | `string` | No | Ozon SKU. |
| `offer_id` | `string` | No | Offer identifier. |

### OnlineProductActionRequest

Managed Ozon online-product action request.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `online_product_id` | `number` | Yes | Local online product identifier. |
| `action_type` | `string` | Yes | Action type such as zero_stock or archive. |
| `warehouse_id` | `string` | No | Optional target warehouse identifier. |
| `payload` | `object` | No | Action-specific payload. |

### OzonWarehouseRecord

Ozon seller warehouse record.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `warehouse_id` | `string` | Yes | Ozon warehouse identifier. |
| `name` | `string` | No | Warehouse display name. |
| `status` | `string` | No | Warehouse status. |
| `delivery_schema` | `string` | No | Delivery schema such as fbs or rfbs. |

### OnlineProductWarehousesResponse

Warehouses available for a shop.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `shop_id` | `number` | Yes | Shop identifier. |
| `shop_name` | `string` | No | Shop display name. |
| `warehouses` | `array<OzonWarehouseRecord>` | Yes | Ozon warehouses. |

### OnlineProductBatchStockRequest

Bulk stock update for selected online products.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `online_product_ids` | `array<number>` | Yes | Selected online product ids. |
| `shop_id` | `number` | No | Target shop identifier. |
| `warehouse_id` | `string` | Yes | Target Ozon warehouse identifier. |
| `stock` | `number` | No | Stock quantity to set. Defaults to 888. |

### OnlineProductBatchStockResponse

Bulk Ozon stock update result.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `boolean` | Yes | Whether the operation succeeded. |
| `shop_id` | `number` | No | Target shop identifier. |
| `warehouse_id` | `string` | No | Target Ozon warehouse identifier. |
| `stock` | `number` | No | Submitted stock quantity. |
| `requested_count` | `number` | No | Number of selected online products. |
| `target_count` | `number` | No | Number of submitted Ozon stock targets. |
| `skipped` | `array<object>` | No | Skipped rows. |

### CreateProductFromOnlineProductRequest

Create an ERP product from an online product.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `online_product_id` | `number` | Yes | Local online product identifier. |
| `owner_person_id` | `number` | No | Assigned owner identifier. |
| `supplier_id` | `number` | No | Linked supplier identifier. |

### SkuMappingRecord

Mapping from Ozon SKU to ERP product ownership.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Mapping identifier. |
| `shop_id` | `number` | No | Owning shop identifier. |
| `product_id` | `number` | No | ERP product identifier. |
| `person_id` | `number` | No | Responsible person identifier. |
| `online_product_id` | `number` | No | Linked online product identifier. |
| `ozon_sku` | `string` | No | Mapped Ozon SKU. |
| `offer_id` | `string` | No | Offer identifier. |
| `display_name` | `string` | No | Optional display label. |
| `commission_low` | `number` | No | Lower commission estimate. |
| `commission_high` | `number` | No | Upper commission estimate. |
| `active` | `number` | No | Whether the mapping is active. |

### SkuMappingMutationRequest

Create or update a SKU mapping.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `shop_id` | `number` | No | Owning shop identifier. |
| `product_id` | `number` | No | ERP product identifier. |
| `person_id` | `number` | No | Responsible owner identifier. |
| `online_product_id` | `number` | No | Linked online product identifier. |
| `ozon_sku` | `string` | Yes | Mapped Ozon SKU. |
| `offer_id` | `string` | No | Offer identifier. |
| `display_name` | `string` | No | Optional display label. |
| `commission_low` | `number` | No | Lower commission estimate. |
| `commission_high` | `number` | No | Upper commission estimate. |
| `active` | `number` | No | Whether the mapping is active. |

### OrderListItem

Flattened order row used by list and workbench pages.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Order identifier. |
| `shop_id` | `number` | No | Owning shop identifier. |
| `shop_name` | `string` | No | Owning shop name. |
| `posting_number` | `string` | No | Ozon posting number. |
| `order_number` | `string` | No | Ozon order number. |
| `status` | `string` | No | Normalized order status. |
| `tracking_stage` | `string` | No | Current tracking stage. |
| `logistics_status` | `string` | No | Carrier-facing logistics status. |
| `ordered_at` | `string` | No | Order timestamp. |
| `delivered_at` | `string` | No | Delivery timestamp when available. |
| `tracking_number` | `string` | No | Tracking number. |
| `item_count` | `number` | No | Distinct line count. |
| `total_quantity` | `number` | No | Summed line quantity. |
| `revenue` | `number` | No | Gross sale amount. |
| `estimated_profit` | `number` | No | Estimated profit total. |
| `actual_profit` | `number` | No | Accrued profit total. |
| `product_codes` | `string` | No | Comma-separated mapped product codes. |
| `product_names` | `string` | No | Comma-separated mapped product names. |
| `skus` | `string` | No | Comma-separated Ozon SKUs. |
| `mark_type` | `string` | No | Operator mark type. |
| `mark_note` | `string` | No | Operator mark note. |
| `printed_at` | `string` | No | Package label print timestamp. |
| `delivery_method_name` | `string` | No | Resolved delivery method name. |
| `warehouse_name` | `string` | No | Resolved warehouse name. |
| `shipment_deadline_at` | `string` | No | Shipment SLA deadline. |
| `ship_days_remaining` | `number` | No | Days remaining before SLA breach. |
| `is_overdue` | `boolean` | No | Whether the shipment deadline has passed. |

### OrderDetailResponse

Detailed order payload with line items and finance breakdown.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `order` | `OrderListItem` | Yes | Order header and computed logistics state. |
| `items` | `array<object>` | Yes | Order lines. |
| `finance` | `array<object>` | Yes | Finance grouping rows. |

### OrdersPagedResponse

Paginated order list response.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rows` | `array<OrderListItem>` | Yes | Current page of orders. |
| `total` | `number` | Yes | Total matching order count. |
| `page` | `number` | Yes | Current page number. |
| `pageSize` | `number` | Yes | Requested page size. |
| `counts` | `object` | Yes | Status bucket counts used by tabs. |
| `mode` | `string` | Yes | Response mode. Current value is paged. |

### OrderQuery

Order list query model.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `paged` | `boolean` | No | When true, return paged mode. |
| `page` | `number` | No | 1-based page number. |
| `pageSize` | `number` | No | Page size, max 100. |
| `shopId` | `string` | No | Shop identifier or all. |
| `dateFrom` | `string` | No | Inclusive start date. |
| `dateTo` | `string` | No | Inclusive end date. |
| `status` | `string` | No | Status tab key. |
| `markFilter` | `string` | No | Mark filter key. |
| `printFilter` | `string` | No | Print-state filter key. |
| `fulfillmentType` | `string` | No | Fulfillment-type filter: all, fbs, or fbp. |
| `searchType` | `string` | No | Search type such as order, tracking, sku, offer, product. |
| `searchQuery` | `string` | No | Search text. |
| `sortMode` | `string` | No | Sort mode key. |

### OrderMarkRequest

Set or clear an operator mark.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mark_type` | `string` | No | Mark type. Empty with empty note clears the mark. |
| `note` | `string` | No | Optional mark note. |

### OrderIdsRequest

Payload for bulk order actions.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `order_ids` | `array<number>` | Yes | Target order identifiers. |

### ShipOrdersRequest

Shipment confirmation payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `order_ids` | `array<number>` | Yes | Target order identifiers. |
| `tracking_number` | `string` | No | Optional shared tracking number. |
| `carrier` | `string` | No | Optional carrier label. |
| `payload` | `object` | No | Optional transport-specific fields. |

### OrderQualityRulesResponse

Quality-rule list payload.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rules` | `array<object>` | No | Resolved rules. |
| `ok` | `boolean` | No | Whether the save operation completed. |

### OrderQualityRulesRequest

Bulk quality-rule replacement payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prefixes` | `array<string>` | No | Active quality-check prefixes. |
| `note` | `string` | No | Shared rule note. |

### DashboardResponse

Dashboard overview for first-page business monitoring.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `summary` | `object` | Yes | Global revenue and profit counters. |
| `commerce` | `object` | No | Dashboard commerce overview blocks. |
| `alerts` | `object` | No | Dashboard alert collections including procurement, FBP, and scheduled jobs. |
| `byShop` | `array<object>` | Yes | Grouped by shop. |
| `byPerson` | `array<object>` | Yes | Grouped by owner. |
| `lowStock` | `array<object>` | Yes | Low local stock products. |
| `exceptions` | `array<object>` | Yes | Open exception counts by type. |
| `orderStages` | `array<object>` | Yes | Order counts by tracking stage. |
| `stockByOwner` | `array<object>` | Yes | Stock grouped by product and owner. |

### ProfitSummaryResponse

Profit aggregates by summary, shop, SKU, and product.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `summary` | `object` | Yes | Overall revenue, profit, cancellation, and return metrics. |
| `byShop` | `array<object>` | Yes | Per-shop rows. |
| `bySku` | `array<object>` | Yes | Per-SKU rows. |
| `byProduct` | `array<object>` | Yes | Per-product rows. |

### ProfitFiltersQuery

Common profit filter query model.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | `string` | No | Inclusive start date. |
| `to` | `string` | No | Inclusive end date. |
| `refresh` | `boolean` | No | Whether to force snapshot refresh. |
| `shopId` | `string` | No | Optional shop filter. |
| `groupBy` | `string` | No | Optional grouping key. |
| `metric` | `string` | No | Optional metric selector. |
| `page` | `number` | No | Optional page number. |
| `pageSize` | `number` | No | Optional page size. |

### ProfitDashboardResponse

Chart-ready profit dashboard payload.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `filters` | `object` | No | Resolved date and grouping filters. |
| `summary` | `object` | No | Top-level KPI cards. |
| `trend` | `array<object>` | No | Chart rows. |
| `ranking` | `array<object>` | No | Ranking rows. |

### HistoricalProfitReviewResponse

Historical profit review workbench payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `summary` | `object` | Yes | KPI summary for the review window. |
| `rows` | `array<object>` | Yes | Review rows. |
| `filters` | `object` | Yes | Resolved query filters. |

### HistoricalProfitReviewActionRequest

Apply manual review actions to historical profit rows.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `string` | Yes | Action key such as keep, clear, recalculate, or reset. |
| `order_item_ids` | `array<number>` | Yes | Target order item identifiers. |
| `note` | `string` | No | Optional operator note. |

### ExceptionWorkbenchResponse

Exception workbench payload for issue triage.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `generatedAt` | `string` | Yes | Server-side generation timestamp. |
| `view` | `string` | Yes | Resolved workbench view key. |
| `summary` | `object` | Yes | Top-level count summary. |
| `counts` | `object` | Yes | Open issue counts by category. |
| `rows` | `array<object>` | Yes | Current page of tasks. |
| `pagination` | `object` | Yes | Pagination state. |

### ExceptionWorkbenchQuery

Exception workbench query model.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `view` | `string` | No | Exception tab key. |
| `search` | `string` | No | Search text. |
| `page` | `number` | No | 1-based page number. |
| `pageSize` | `number` | No | Page size, max 200. |
| `sortField` | `string` | No | Sort field key. |
| `sortDirection` | `string` | No | Sort direction key. |
| `dateFrom` | `string` | No | Inclusive start date. |
| `dateTo` | `string` | No | Inclusive end date. |
| `refresh` | `boolean` | No | Force rebuild the cached workbench view. |

### ExceptionTaskStateRequest

Persist manual task state.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `task_id` | `string` | Yes | Stable task identifier. |
| `status` | `string` | Yes | Desired task state such as open, handled, or ignored. |
| `note` | `string` | No | Optional operator note. |

### DateRangeSyncRequest

Date-range sync payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | `string` | No | Inclusive start date in YYYY-MM-DD. |
| `to` | `string` | No | Inclusive end date in YYYY-MM-DD. |
| `shop_id` | `number` | No | Optional target shop identifier. |
| `force` | `boolean` | No | Whether to bypass light guards. |
| `limit` | `number` | No | Optional sync item limit. |

### InventorySnapshot

Inventory rows with product, quantity, owner, and computed stock state.

Type: `array<object>`

### StockAlertsResponse

Inventory alert rows with warning badges and replenishment suggestions.

Type: `array<object>`

### InventoryMovementRequest

Manual inventory movement payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `product_id` | `number` | Yes | Target product identifier. |
| `shop_id` | `number` | No | Related shop identifier. |
| `sku_mapping_id` | `number` | No | Related SKU mapping identifier. |
| `owner_person_id` | `number` | No | Owner identifier. |
| `source_type` | `string` | Yes | Movement source type. |
| `source_ref` | `string` | No | External source reference. |
| `quantity_delta` | `number` | Yes | Positive or negative stock delta. |
| `unit_cost` | `number` | No | Unit cost. |
| `amount` | `number` | No | Total amount. |
| `status` | `string` | No | Movement status. |
| `note` | `string` | No | Operator note. |

### ProcurementRequestRecord

Procurement request row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Request identifier. |
| `product_id` | `number` | No | Target product identifier. |
| `person_id` | `number` | No | Requester or owner identifier. |
| `quantity` | `number` | No | Requested quantity. |
| `amount` | `number` | No | Merchandise amount. |
| `shipping_amount` | `number` | No | Estimated shipping amount. |
| `supplier_id` | `number` | No | Selected supplier identifier. |
| `approval_status` | `string` | No | Approval status. |
| `status` | `string` | No | Request execution status. |
| `needed_by` | `string` | No | Needed-by date. |
| `note` | `string` | No | Operator note. |
| `created_at` | `string` | No | Creation timestamp. |

### ProcurementRequestMutationRequest

Create or update a procurement request.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `product_id` | `number` | Yes | Target product identifier. |
| `person_id` | `number` | No | Requester or owner identifier. |
| `quantity` | `number` | Yes | Requested quantity. |
| `amount` | `number` | No | Merchandise amount. |
| `shipping_amount` | `number` | No | Estimated shipping amount. |
| `purchase_url` | `string` | No | Procurement link. |
| `source_type` | `string` | No | Procurement source type. |
| `supplier_id` | `number` | No | Selected supplier identifier. |
| `approval_status` | `string` | No | Approval status. |
| `status` | `string` | No | Request execution status. |
| `needed_by` | `string` | No | Needed-by date. |
| `note` | `string` | No | Operator note. |

### ProcurementSubmitRequest

Bulk procurement submit payload.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `request_ids` | `array<number>` | Yes | Target request identifiers. |
| `note` | `string` | No | Optional batch note. |

### PurchaseOrderRecord

Aggregated purchase-order header.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Purchase-order identifier. |
| `supplier_id` | `number` | No | Supplier identifier. |
| `status` | `string` | No | Purchase-order status. |
| `item_count` | `number` | No | Number of merged request lines. |
| `total_quantity` | `number` | No | Summed quantity. |
| `total_amount` | `number` | No | Summed purchase amount. |
| `purchased_at` | `string` | No | Purchase confirmation timestamp. |
| `created_at` | `string` | No | Creation timestamp. |

### MergePurchaseOrdersRequest

Merge procurement requests into a purchase order.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `request_ids` | `array<number>` | Yes | Request identifiers to merge. |
| `supplier_id` | `number` | No | Supplier identifier. |
| `note` | `string` | No | Optional purchase-order note. |

### PurchaseOrderMutationRequest

Update a purchase order.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `supplier_id` | `number` | No | Supplier identifier. |
| `status` | `string` | No | Purchase-order status. |
| `note` | `string` | No | Operator note. |
| `purchase_url` | `string` | No | Optional procurement link. |

### PurchaseOrderConfirmRequest

Confirm purchase-order purchase.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `purchased_at` | `string` | No | Purchase timestamp. |
| `note` | `string` | No | Optional operator note. |

### InboundRecord

Inbound shipment or arrival record.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Inbound record identifier. |
| `product_id` | `number` | No | Product identifier. |
| `person_id` | `number` | No | Owner or operator identifier. |
| `quantity` | `number` | No | Inbound quantity. |
| `amount` | `number` | No | Inbound merchandise amount. |
| `unit_cost` | `number` | No | Unit cost. |
| `shipping_amount` | `number` | No | Shipping amount. |
| `status` | `string` | No | Inbound status. |
| `note` | `string` | No | Operator note. |
| `created_at` | `string` | No | Creation timestamp. |
| `approved_at` | `string` | No | Approval timestamp. |

### InboundRecordMutationRequest

Create or update an inbound record.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `product_id` | `number` | Yes | Product identifier. |
| `person_id` | `number` | No | Owner or operator identifier. |
| `quantity` | `number` | Yes | Inbound quantity. |
| `amount` | `number` | No | Inbound merchandise amount. |
| `unit_cost` | `number` | No | Unit cost. |
| `shipping_amount` | `number` | No | Shipping amount. |
| `purchase_url` | `string` | No | Procurement link. |
| `status` | `string` | No | Inbound status. |
| `note` | `string` | No | Operator note. |

### OutboundRecord

Outbound stock deduction row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Outbound record identifier. |
| `product_id` | `number` | No | Product identifier. |
| `shop_id` | `number` | No | Shop identifier. |
| `online_product_id` | `number` | No | Online product identifier. |
| `order_ref` | `string` | No | Reference order number. |
| `person_id` | `number` | No | Responsible person identifier. |
| `quantity` | `number` | No | Deducted quantity. |
| `reason` | `string` | No | Deduction reason. |
| `status` | `string` | No | Outbound status. |
| `note` | `string` | No | Operator note. |
| `created_at` | `string` | No | Creation timestamp. |

### LogisticsRule

Logistics fee rule row.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Rule identifier. |
| `name` | `string` | No | Rule name. |
| `carrier` | `string` | No | Carrier name. |
| `channel` | `string` | No | Channel name. |
| `mode` | `string` | No | Pricing mode. |
| `min_weight_g` | `number` | No | Lower weight bound in grams. |
| `max_weight_g` | `number` | No | Upper weight bound in grams. |
| `base_fee_cny` | `number` | No | Base fee in CNY. |
| `per_gram_cny` | `number` | No | Per-gram fee in CNY. |
| `per_ticket_cny` | `number` | No | Per-ticket fee in CNY. |
| `enabled` | `number` | No | Whether the rule is active. |
| `version_group_id` | `number` | No | Stable identifier shared by versions of one rule. |
| `effective_from` | `string` | No | Version effective timestamp. |
| `effective_to` | `string` | No | Version expiration timestamp. |
| `note` | `string` | No | Operator note. |

### LogisticsRuleMutationRequest

Create or update a logistics fee rule.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Rule name. |
| `carrier` | `string` | No | Carrier name. |
| `channel` | `string` | No | Channel name. |
| `mode` | `string` | No | Pricing mode. |
| `min_weight_g` | `number` | No | Lower weight bound in grams. |
| `max_weight_g` | `number` | No | Upper weight bound in grams. |
| `min_price_rub` | `number` | No | Lower listing-price bound in RUB. |
| `max_price_rub` | `number` | No | Upper listing-price bound in RUB. |
| `source_rule_id` | `number` | No | Source version identifier when creating a new version. |
| `effective_from` | `string` | No | New version effective time in Beijing time. |
| `base_fee_cny` | `number` | No | Base fee in CNY. |
| `per_gram_cny` | `number` | No | Per-gram fee in CNY. |
| `per_ticket_cny` | `number` | No | Per-ticket fee in CNY. |
| `enabled` | `number` | No | Whether the rule is active. |
| `note` | `string` | No | Operator note. |

### StockWarehouseRule

Warehouse text-classification rule for Ozon stock snapshots.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Rule identifier. |
| `pattern` | `string` | No | Case-insensitive text pattern. |
| `stock_type` | `string` | No | Target stock type such as fbs_virtual or fbp_real. |
| `enabled` | `number` | No | Whether the rule is active. |
| `note` | `string` | No | Operator note. |

### StockWarehouseRuleMutationRequest

Create or update a stock warehouse classification rule.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Case-insensitive text pattern. |
| `stock_type` | `string` | Yes | Target stock type such as fbs_virtual or fbp_real. |
| `enabled` | `number` | No | Whether the rule is active. |
| `note` | `string` | No | Operator note. |

### OrderCancellationRule

Cancellation or return classification rule.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Rule identifier. |
| `name` | `string` | No | Rule name. |
| `match_text` | `string` | No | Matched text fragment. |
| `match_mode` | `string` | No | Matching mode such as contains. |
| `initiator_label` | `string` | No | Resolved initiator label. |
| `reason_label` | `string` | No | Resolved reason label. |
| `reason_code` | `string` | No | Stable reason code. |
| `reason_group_label` | `string` | No | Grouped reason label. |
| `accounting_hint` | `string` | No | Accounting interpretation hint. |
| `priority` | `number` | No | Lower values match first. |
| `enabled` | `number` | No | Whether the rule is active. |
| `note` | `string` | No | Operator note. |

### OrderCancellationRuleMutationRequest

Create or update a cancellation rule.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Rule name. |
| `match_text` | `string` | Yes | Matched text fragment. |
| `match_mode` | `string` | No | Matching mode such as contains. |
| `initiator_label` | `string` | No | Resolved initiator label. |
| `reason_label` | `string` | No | Resolved human-readable reason label. |
| `reason_code` | `string` | No | Stable reason code. |
| `reason_group_label` | `string` | No | Grouped reason label. |
| `accounting_hint` | `string` | No | Accounting interpretation hint. |
| `priority` | `number` | No | Priority order. Lower numbers match first. |
| `enabled` | `number` | No | Whether the rule is active. |
| `note` | `string` | No | Operator note. |

### OrderCancellationRuleTestRequest

Evaluate cancellation-rule matching.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | `string` | Yes | Sample raw cancellation text. |
| `status` | `string` | No | Optional order status sample. |
| `tracking_stage` | `string` | No | Optional tracking-stage sample. |

### CelFbsPricingRequest

Run the CEL FBS pricing calculator.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sale_price_rub` | `number` | Yes | Listing or sale price in RUB. |
| `weight_g` | `number` | Yes | Package weight in grams. |
| `length_cm` | `number` | No | Package length in centimeters. |
| `width_cm` | `number` | No | Package width in centimeters. |
| `height_cm` | `number` | No | Package height in centimeters. |
| `exchange_rate` | `number` | No | CNY to RUB exchange rate. |
| `target_margin` | `number` | No | Target margin ratio. |

### AiStrategyBundle

AI strategy bundle that binds a category to per-asset strategy keys.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Bundle identifier. |
| `bundle_key` | `string` | No | Stable bundle key. |
| `title` | `string` | No | Bundle title. |
| `description` | `string` | No | Operator-facing bundle summary. |
| `category_node_id` | `number` | No | Linked AI strategy category node identifier. |
| `match_keywords` | `array<string>` | No | Keywords that boost bundle matching. |
| `exclude_keywords` | `array<string>` | No | Keywords that suppress bundle matching. |
| `strategy_map` | `object` | No | Map of asset key to strategy keys. |
| `priority` | `number` | No | Bundle sort priority. |
| `enabled` | `number` | No | Whether the bundle is enabled. |

### AiStrategyCategoryNode

Searchable AI strategy category node used to organize strategy bundles.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | No | Category node identifier. |
| `parent_id` | `number` | No | Parent category node identifier. |
| `category_key` | `string` | No | Stable category key. |
| `title` | `string` | No | Category title. |
| `aliases` | `array<string>` | No | Aliases used for search and matching. |
| `match_keywords` | `array<string>` | No | Keywords used for search and matching. |
| `sort_order` | `number` | No | Category sort order. |
| `enabled` | `number` | No | Whether the category node is enabled. |

### AiStrategyBundleMatchRequest

Product context used to recommend category strategy bundles.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `productName` | `string` | No | Product name or listing title. |
| `categoryText` | `string` | No | Collected category, Ozon category, or operator category text. |
| `ozonCategory` | `string` | No | Ozon category label. |
| `material` | `string` | No | Material text such as stainless steel, ABS, or carbon sticker. |
| `color` | `string` | No | Color text. |
| `sellingPoints` | `string` | No | Known product selling points. |

### AiStrategyBundleMatchResponse

Matched category and ranked strategy bundle recommendations.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `inputText` | `string` | No | Normalized input text used for matching. |
| `category` | `object` | No | Matched category node with path. |
| `bundles` | `array<AiStrategyBundle>` | No | Ranked matching bundles. |
| `defaultBundle` | `AiStrategyBundle` | No | Highest ranked bundle. |

### AiStrategyPlanRequest

Resolve AI strategies from goal, category text, optional selected titles, and optional strategy bundle.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `businessMode` | `string` | No | Business mode such as product_optimization or product_variant. |
| `goalKey` | `string` | No | Goal key such as low_ctr or low_conversion. |
| `categoryText` | `string` | No | Category text used for inherited layer rules. |
| `selectedTitles` | `array<string>` | No | Manual strategy titles. |
| `bundleKey` | `string` | No | Optional selected strategy bundle key. |
| `bundleId` | `number` | No | Optional selected strategy bundle identifier. |
| `assets` | `array<string>` | No | Optional asset filter such as main_image or detail_image. |

### AiStrategyPlanResponse

Resolved AI strategy plan with strategy modules and optional selected bundle.

`additionalProperties: false`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `string` | No | Strategy library version. |
| `businessMode` | `string` | No | Resolved business mode. |
| `goalKey` | `string` | No | Resolved goal key. |
| `layers` | `array<object>` | No | Matched layers. |
| `bundle` | `object` | No | Selected bundle summary, when a bundle was supplied. |
| `strategies` | `array<object>` | No | Resolved strategies. |
| `strategyIds` | `array<string>` | No | Resolved strategy keys. |
| `strategyTitles` | `array<string>` | No | Resolved strategy titles. |
| `positiveModules` | `array<string>` | No | Positive prompt modules. |
| `negativeModules` | `array<string>` | No | Negative prompt modules. |
| `assets` | `array<string>` | No | Affected asset keys. |

## Endpoints

### Docs

#### `GET /api/docs`

Return the machine-readable API catalog.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `ApiCatalog`

#### `GET /api/docs/markdown`

Return the generated Markdown API reference.

- Auth: `authenticated`
- Responses:
  - `200` `text/markdown` -> `string`

### System

#### `GET /api/system/info`

Return current runtime and deployment information.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `SystemInfo`

#### `GET /api/scheduled-jobs`

Return persisted background task schedules with recent run status.

- Auth: `authenticated`
- Query parameters:
  - `run_limit` (`number`, optional): Number of recent runs to include per job.
- Responses:
  - `200` `application/json` -> `array<ScheduledJob>`

#### `GET /api/scheduled-job-runs`

Return background task execution history.

- Auth: `authenticated`
- Query parameters:
  - `job_key` (`string`, optional): Optional scheduled job key filter.
  - `limit` (`number`, optional): Maximum number of run rows to return.
- Responses:
  - `200` `application/json` -> `array<ScheduledJobRun>`

#### `POST /api/scheduled-jobs/run`

Run one scheduled background task immediately and record the manual run.

- Auth: `authenticated`
- Request body: required
  - Schema: `ScheduledJobRunRequest`
- Responses:
  - `200` `application/json` -> `ScheduledJob`

#### `POST /api/scheduled-jobs/state`

Enable or disable a scheduled background task.

- Auth: `authenticated`
- Request body: required
  - Schema: `ScheduledJobStateRequest`
- Responses:
  - `200` `application/json` -> `ScheduledJob`

#### `POST /api/scheduled-jobs/config`

Update a scheduled background task runtime configuration.

- Auth: `authenticated`
- Request body: required
  - Schema: `ScheduledJobConfigRequest`
- Responses:
  - `200` `application/json` -> `ScheduledJob`

### Auth

#### `POST /api/auth/login`

Authenticate a user and return a bearer token.

- Auth: `public`
- Request body: required
  - Schema: `LoginRequest`
- Responses:
  - `200` `application/json` -> `AuthSession`
  - `429` `application/json` -> `ErrorResponse`: Returned when login rate limit is exceeded.

#### `GET /api/auth/me`

Resolve the current user from the bearer token.

- Auth: `public`
- Responses:
  - `200` `application/json` -> `AuthUser`: Returned when the token is valid.
  - `200` `application/json` -> `null`: Null response when not authenticated.

#### `POST /api/auth/logout`

Invalidate the current session token.

- Auth: `public`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/auth/change-password`

Change the current user's password.

- Auth: `authenticated`
- Request body: required
  - Schema: `ChangePasswordRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

### Dashboard And Profit

#### `GET /api/dashboard`

Return dashboard summary counters and grouped metrics.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `DashboardResponse`

#### `GET /api/exchange-rate/current`

Return the latest effective CNY to RUB exchange rate.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `ExchangeRate`

#### `GET /api/exchange-rates`

Return recent exchange-rate history.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ExchangeRate>`

#### `POST /api/exchange-rate`

Create a new manual exchange-rate record.

- Auth: `authenticated`
- Request body: required
  - Schema: `ExchangeRateUpdateRequest`
- Responses:
  - `200` `application/json` -> `ExchangeRate`

#### `GET /api/profit-summary`

Return aggregate profit metrics by summary, shop, SKU, and product.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
- Responses:
  - `200` `application/json` -> `ProfitSummaryResponse`

#### `GET /api/profit-dashboard`

Return chart-ready profit dashboard data for the selected period.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
  - `shopId` (`string`, optional): Optional shop filter.
  - `groupBy` (`string`, optional): Optional grouping key.
  - `metric` (`string`, optional): Optional metric selector.
  - `page` (`number`, optional): Optional page number.
  - `pageSize` (`number`, optional): Optional page size.
- Responses:
  - `200` `application/json` -> `ProfitDashboardResponse`

#### `GET /api/profit-ranking`

Return ranking rows for the selected profit dimension.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
  - `shopId` (`string`, optional): Optional shop filter.
  - `groupBy` (`string`, optional): Optional grouping key.
  - `metric` (`string`, optional): Optional metric selector.
  - `page` (`number`, optional): Optional page number.
  - `pageSize` (`number`, optional): Optional page size.
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/profit-reconciliation`

Compare estimated and finance-accrued profit and identify inventory-data risks.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
  - `shopId` (`string`, optional): Optional shop filter.
  - `groupBy` (`string`, optional): Optional grouping key.
  - `metric` (`string`, optional): Optional metric selector.
  - `page` (`number`, optional): Optional page number.
  - `pageSize` (`number`, optional): Optional page size.
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/profit-details`

Return detailed profit rows for drill-down views.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
  - `shopId` (`string`, optional): Optional shop filter.
  - `groupBy` (`string`, optional): Optional grouping key.
  - `metric` (`string`, optional): Optional metric selector.
  - `page` (`number`, optional): Optional page number.
  - `pageSize` (`number`, optional): Optional page size.
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/profits/historical-review`

Return historical profit review candidates and review state.

- Auth: `authenticated`
- Query parameters:
  - `from` (`string`, optional): Inclusive start date.
  - `to` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Whether to force snapshot refresh.
  - `shopId` (`string`, optional): Optional shop filter.
  - `groupBy` (`string`, optional): Optional grouping key.
  - `metric` (`string`, optional): Optional metric selector.
  - `page` (`number`, optional): Optional page number.
  - `pageSize` (`number`, optional): Optional page size.
- Responses:
  - `200` `application/json` -> `HistoricalProfitReviewResponse`

#### `POST /api/profits/historical-review/actions`

Apply an operator review action to historical profit rows.

- Auth: `authenticated`
- Request body: required
  - Schema: `HistoricalProfitReviewActionRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/profit-snapshots/refresh`

Refresh analytics snapshot tables used by profit dashboards.

- Auth: `authenticated`
- Request body: optional
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/profits/recalculate-historical`

Recalculate historical order profit items for a selected scope.

- Auth: `authenticated`
- Request body: required
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/profits/cleanup-delivered-return-loss`

Normalize delivered-return loss flags and derived profit data.

- Auth: `authenticated`
- Request body: optional
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/ozon-finance/summary`

Return Ozon finance ingestion summary values.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `object`

### Exception Workbench

#### `GET /api/exception-workbench`

Return the current exception workbench task list and counts.

- Auth: `authenticated`
- Query parameters:
  - `view` (`string`, optional): Exception tab key.
  - `search` (`string`, optional): Search text.
  - `page` (`number`, optional): 1-based page number.
  - `pageSize` (`number`, optional): Page size, max 200.
  - `sortField` (`string`, optional): Sort field key.
  - `sortDirection` (`string`, optional): Sort direction key.
  - `dateFrom` (`string`, optional): Inclusive start date.
  - `dateTo` (`string`, optional): Inclusive end date.
  - `refresh` (`boolean`, optional): Force rebuild the cached workbench view.
- Responses:
  - `200` `application/json` -> `ExceptionWorkbenchResponse`

#### `POST /api/exception-workbench/sync`

Synchronize recent Ozon orders for the exception-workbench window.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/exception-workbench/tasks/state`

Persist manual task state such as open, resolved, and ignored.

- Auth: `authenticated`
- Request body: required
  - Schema: `ExceptionTaskStateRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

### Orders

#### `GET /api/orders`

Return the full order list or paged order list depending on the paged query flag.

- Auth: `authenticated`
- Query parameters:
  - `paged` (`boolean`, optional): When true, return paged mode.
  - `page` (`number`, optional): 1-based page number.
  - `pageSize` (`number`, optional): Page size, max 100.
  - `shopId` (`string`, optional): Shop identifier or all.
  - `dateFrom` (`string`, optional): Inclusive start date.
  - `dateTo` (`string`, optional): Inclusive end date.
  - `status` (`string`, optional): Status tab key.
  - `markFilter` (`string`, optional): Mark filter key.
  - `printFilter` (`string`, optional): Print-state filter key.
  - `fulfillmentType` (`string`, optional): Fulfillment-type filter: all, fbs, or fbp.
  - `searchType` (`string`, optional): Search type such as order, tracking, sku, offer, product.
  - `searchQuery` (`string`, optional): Search text.
  - `sortMode` (`string`, optional): Sort mode key.
- Responses:
  - `200` `application/json` -> `array<OrderListItem>`: Returned when paged is not set.
  - `200` `application/json` -> `OrdersPagedResponse`: Returned when paged=1 or paged=true.

#### `GET /api/orders/:id`

Return detailed information for a single order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Order identifier.
- Responses:
  - `200` `application/json` -> `OrderDetailResponse`
  - `404` `application/json` -> `ErrorResponse`

#### `PUT /api/orders/:id/mark`

Create, replace, or clear an operator mark for an order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Order identifier.
- Request body: required
  - Schema: `OrderMarkRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/orders/package-label`

Generate a shipping label PDF for one or more orders.

- Auth: `authenticated`
- Request body: required
  - Schema: `OrderIdsRequest`
- Responses:
  - `200` `application/pdf` -> `binary`

#### `POST /api/orders/package-label-printed`

Mark one or more orders as label printed.

- Auth: `authenticated`
- Request body: required
  - Schema: `OrderIdsRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/orders/ship`

Submit shipment confirmation to Ozon for selected orders.

- Auth: `authenticated`
- Request body: required
  - Schema: `ShipOrdersRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/orders/:id/recalculate-profit`

Recalculate profit data for a single order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Order identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/orders/recalculate-profits`

Recalculate profit data for all mapped orders.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/order-quality-rules`

Return order quality-check prefix rules.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `PUT /api/order-quality-rules`

Replace order quality-check prefix rules in bulk.

- Auth: `authenticated`
- Request body: required
  - Schema: `OrderQualityRulesRequest`
- Responses:
  - `200` `application/json` -> `OrderQualityRulesResponse`

### Catalog

#### `GET /api/products`

Return active product master data with inventory and profit metrics.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ProductRecord>`

#### `GET /api/products/selection`

Return selection-facing product records.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ProductRecord>`

#### `GET /api/products/hidden`

Return archived or hidden products.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ProductRecord>`

#### `GET /api/products/:id`

Return one product with full computed detail.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `ProductRecord`
  - `404` `application/json` -> `ErrorResponse`

#### `GET /api/products/:id/image`

Return the stored product image binary.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `image/*` -> `binary`
  - `404` `application/json` -> `ErrorResponse`

#### `GET /api/products/:id/order-profit-details`

Return per-order profit rows for a product.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/products/:id/cancel-details`

Return cancellation and return details for a product.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `array<object>`

#### `POST /api/products`

Create a new product and return the enriched detail row.

- Auth: `authenticated`
- Request body: required
  - Schema: `ProductMutationRequest`
- Responses:
  - `200` `application/json` -> `ProductCreateResponse`

#### `PUT /api/products/:id`

Update a product in place.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Request body: required
  - Schema: `ProductMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/products/:id`

Soft-delete a product.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/products/:id/restore`

Restore a previously hidden product.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/products/:id/recalculate-profits`

Recalculate all order profits linked to the selected product.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Product identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/products/import-preview`

Parse imported product CSV data without persisting it.

- Auth: `authenticated`
- Request body: required
  - Schema: `ProductImportPreviewRequest`
- Responses:
  - `200` `application/json` -> `ProductImportPreviewResponse`

#### `POST /api/products/import-commit`

Persist a previously validated product CSV import batch.

- Auth: `authenticated`
- Request body: required
  - Schema: `ProductImportCommitRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/online-products`

Return Ozon online-product rows with local bindings.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<OnlineProductRecord>`

#### `POST /api/online-products`

Create a local online-product row.

- Auth: `authenticated`
- Request body: required
  - Schema: `OnlineProductMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `PUT /api/online-products/:id`

Update a local online-product row.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Online-product identifier.
- Request body: required
  - Schema: `OnlineProductMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/online-products/bind`

Bind an online product to an ERP product and owner.

- Auth: `authenticated`
- Request body: required
  - Schema: `OnlineProductBindRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/online-products/warehouses`

Return Ozon warehouses for a shop.

- Auth: `authenticated`
- Query parameters:
  - `shop_id` (`number`, required): Shop identifier.
- Responses:
  - `200` `application/json` -> `OnlineProductWarehousesResponse`

#### `POST /api/online-products/batch-stock`

Update Ozon stock for selected online products.

- Auth: `authenticated`
- Request body: required
  - Schema: `OnlineProductBatchStockRequest`
- Responses:
  - `200` `application/json` -> `OnlineProductBatchStockResponse`

#### `POST /api/online-products/action`

Record and execute a managed online-product action.

- Auth: `authenticated`
- Request body: required
  - Schema: `OnlineProductActionRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/online-products/create-product`

Create a new ERP product from an online product.

- Auth: `authenticated`
- Request body: required
  - Schema: `CreateProductFromOnlineProductRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/mappings`

Return SKU mapping rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<SkuMappingRecord>`

#### `PUT /api/mappings/:id`

Update an existing SKU mapping.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): SKU mapping identifier.
- Request body: required
  - Schema: `SkuMappingMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/mappings/:id`

Delete or deactivate an existing SKU mapping.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): SKU mapping identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/image-proxy`

Fetch a remote image through the backend with response validation.

- Auth: `authenticated`
- Query parameters:
  - `url` (`string`, required): Absolute HTTP or HTTPS image URL to proxy.
- Responses:
  - `200` `image/*` -> `binary`

### Inventory

#### `GET /api/inventory`

Return inventory overview rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `InventorySnapshot`

#### `GET /api/stock-alerts`

Return inventory alert rows and replenishment suggestions.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `StockAlertsResponse`

#### `GET /api/stock-warehouse-rules`

Return stock warehouse classification rules.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<StockWarehouseRule>`

#### `POST /api/stock-warehouse-rules`

Create a stock warehouse classification rule.

- Auth: `authenticated`
- Request body: required
  - Schema: `StockWarehouseRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `IdResponse`

#### `PUT /api/stock-warehouse-rules/:id`

Update a stock warehouse classification rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Warehouse-rule identifier.
- Request body: required
  - Schema: `StockWarehouseRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/stock-warehouse-rules/:id`

Disable a stock warehouse classification rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Warehouse-rule identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/erp/inventory-current`

Return the current inventory_current materialized stock rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/erp/raw-orders`

Return raw Ozon order payload rows stored for troubleshooting.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/erp/profit-items`

Return raw order_profit_items rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `GET /api/erp/order-exceptions`

Return raw order_exceptions rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `POST /api/inventory/movements`

Create a manual inventory movement row.

- Auth: `authenticated`
- Request body: required
  - Schema: `InventoryMovementRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/inventory/stock-debts`

Return products whose posted inventory ledger is negative.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/inventory/stock-debts/adjust`

Create a positive manual adjustment to clear historical negative stock debt.

- Auth: `authenticated`
- Request body: required
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/inbound-records`

Return inbound record rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<InboundRecord>`

#### `POST /api/inbound-records`

Create an inbound record.

- Auth: `authenticated`
- Request body: required
  - Schema: `InboundRecordMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `PUT /api/inbound-records/:id`

Update an inbound record.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Inbound-record identifier.
- Request body: required
  - Schema: `InboundRecordMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/inbound-records/:id`

Delete an inbound record.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Inbound-record identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/outbound-records`

Return outbound stock deduction rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<OutboundRecord>`

### Procurement

#### `GET /api/procurement/summary`

Return procurement summary counters.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/procurement/requests`

Return procurement request rows.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ProcurementRequestRecord>`

#### `POST /api/procurement/requests`

Create a procurement request.

- Auth: `authenticated`
- Request body: required
  - Schema: `ProcurementRequestMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `PUT /api/procurement/requests/:id`

Update a procurement request.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Procurement-request identifier.
- Request body: required
  - Schema: `ProcurementRequestMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/procurement/requests/submit`

Bulk-submit procurement requests for approval or purchase merging.

- Auth: `authenticated`
- Request body: required
  - Schema: `ProcurementSubmitRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `DELETE /api/procurement/requests/:id`

Delete a procurement request.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Procurement-request identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/procurement/purchase-orders`

Return purchase-order headers.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<PurchaseOrderRecord>`

#### `POST /api/procurement/purchase-orders`

Merge selected procurement requests into a purchase order.

- Auth: `authenticated`
- Request body: required
  - Schema: `MergePurchaseOrdersRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `GET /api/procurement/purchase-orders/:id`

Return one purchase order with merged line items.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Purchase-order identifier.
- Responses:
  - `200` `application/json` -> `object`
  - `404` `application/json` -> `ErrorResponse`

#### `PUT /api/procurement/purchase-orders/:id`

Update a purchase order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Purchase-order identifier.
- Request body: required
  - Schema: `PurchaseOrderMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/procurement/purchase-orders/:id`

Delete a purchase order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Purchase-order identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/procurement/purchase-orders/:id/confirm-purchased`

Confirm that a purchase order has been purchased.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Purchase-order identifier.
- Request body: optional
  - Schema: `PurchaseOrderConfirmRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/procurement/purchase-orders/:id/cancel`

Cancel a purchase order.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Purchase-order identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/procurement/pending-inbound`

Return procurement items that are still waiting for inbound completion.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

### Configuration

#### `GET /api/ai-strategies`

Return AI strategy atoms used by prompt plans.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<object>`

#### `POST /api/ai-strategies/resolve`

Resolve an AI prompt strategy plan from goal, category context, selected strategies, and optional bundle.

- Auth: `authenticated`
- Request body: required
  - Schema: `AiStrategyPlanRequest`
- Responses:
  - `200` `application/json` -> `AiStrategyPlanResponse`

#### `GET /api/ai-strategy-category-nodes`

Return AI strategy category tree nodes.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<AiStrategyCategoryNode>`

#### `POST /api/ai-strategy-category-nodes`

Create a searchable AI strategy category node.

- Auth: `authenticated`
- Request body: required
  - Schema: `AiStrategyCategoryNode`
- Responses:
  - `200` `application/json` -> `AiStrategyCategoryNode`

#### `GET /api/ai-strategy-category-nodes/:id`

Return one AI strategy category node.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Category node identifier.
- Responses:
  - `200` `application/json` -> `AiStrategyCategoryNode`
  - `404` `application/json` -> `ErrorResponse`

#### `PUT /api/ai-strategy-category-nodes/:id`

Update a searchable AI strategy category node.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Category node identifier.
- Request body: required
  - Schema: `AiStrategyCategoryNode`
- Responses:
  - `200` `application/json` -> `AiStrategyCategoryNode`

#### `GET /api/ai-strategy-bundles`

Return AI category strategy bundles.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<AiStrategyBundle>`

#### `POST /api/ai-strategy-bundles`

Create an AI category strategy bundle.

- Auth: `authenticated`
- Request body: required
  - Schema: `AiStrategyBundle`
- Responses:
  - `200` `application/json` -> `AiStrategyBundle`

#### `GET /api/ai-strategy-bundles/:id`

Return one AI category strategy bundle.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Strategy bundle identifier.
- Responses:
  - `200` `application/json` -> `AiStrategyBundle`
  - `404` `application/json` -> `ErrorResponse`

#### `PUT /api/ai-strategy-bundles/:id`

Update an AI category strategy bundle.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Strategy bundle identifier.
- Request body: required
  - Schema: `AiStrategyBundle`
- Responses:
  - `200` `application/json` -> `AiStrategyBundle`

#### `POST /api/ai-strategy-bundles/match`

Recommend AI category strategy bundles from product context.

- Auth: `authenticated`
- Request body: required
  - Schema: `AiStrategyBundleMatchRequest`
- Responses:
  - `200` `application/json` -> `AiStrategyBundleMatchResponse`

#### `GET /api/team/tasks`

Return team planning tasks.

- Auth: `authenticated`
- Query parameters:
  - `period` (`string`, optional): Optional period filter.
  - `type` (`string`, optional): Optional work-type filter.
  - `owner_person_id` (`number`, optional): Optional owner filter.
  - `status` (`string`, optional): Optional status filter.
- Responses:
  - `200` `application/json` -> `array<TeamTaskRecord>`

#### `POST /api/team/tasks`

Create a team planning task.

- Auth: `authenticated`
- Request body: required
  - Schema: `TeamTaskMutationRequest`
- Responses:
  - `200` `application/json` -> `IdResponse`

#### `POST /api/team/attachments`

Upload an attachment for a product-development candidate.

- Auth: `authenticated`
- Request body: required
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `object`

#### `PUT /api/team/tasks/:id`

Update a team planning task.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Task identifier.
- Request body: required
  - Schema: `TeamTaskMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/team/tasks/:id`

Delete a team planning task.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Task identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/shops`

Return shop master data.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<ShopRecord>`

#### `POST /api/shops`

Create a shop.

- Auth: `authenticated`
- Request body: required
  - Schema: `ShopMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `PUT /api/shops/:id`

Update a shop.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Shop identifier.
- Request body: required
  - Schema: `ShopMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/shops/:id`

Delete or deactivate a shop.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Shop identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/people`

Return person master data.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<PersonRecord>`

#### `POST /api/people`

Create a person.

- Auth: `authenticated`
- Request body: required
  - Schema: `PersonMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `PUT /api/people/:id`

Update a person.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Person identifier.
- Request body: required
  - Schema: `PersonMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/people/:id`

Soft-delete a person, or hard-delete when hard=1 is set.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Person identifier.
- Query parameters:
  - `hard` (`boolean`, optional): When true, attempt hard deletion.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/suppliers`

Return supplier master data.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<SupplierRecord>`

#### `POST /api/suppliers`

Create a supplier.

- Auth: `authenticated`
- Request body: required
  - Schema: `SupplierMutationRequest`
- Responses:
  - `200` `application/json` -> `IdResponse`

#### `PUT /api/suppliers/:id`

Update a supplier.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Supplier identifier.
- Request body: required
  - Schema: `SupplierMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/suppliers/:id`

Deactivate a supplier after link validation.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Supplier identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/logistics-rules`

Return logistics fee rules.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<LogisticsRule>`

#### `POST /api/logistics-rules`

Create a logistics fee rule.

- Auth: `authenticated`
- Request body: required
  - Schema: `LogisticsRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `IdResponse`

#### `PUT /api/logistics-rules/:id`

Update a logistics fee rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Logistics-rule identifier.
- Request body: required
  - Schema: `LogisticsRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/logistics-rules/:id`

Delete an unreferenced logistics fee rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Logistics-rule identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `GET /api/order-cancellation-rules`

Return cancellation and return classification rules.

- Auth: `authenticated`
- Responses:
  - `200` `application/json` -> `array<OrderCancellationRule>`

#### `POST /api/order-cancellation-rules`

Create a cancellation classification rule.

- Auth: `authenticated`
- Request body: required
  - Schema: `OrderCancellationRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `IdResponse`

#### `PUT /api/order-cancellation-rules/:id`

Update a cancellation classification rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Cancellation-rule identifier.
- Request body: required
  - Schema: `OrderCancellationRuleMutationRequest`
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `DELETE /api/order-cancellation-rules/:id`

Disable a cancellation classification rule.

- Auth: `authenticated`
- Path parameters:
  - `id` (`number`, required): Cancellation-rule identifier.
- Responses:
  - `200` `application/json` -> `MutationOk`

#### `POST /api/order-cancellation-rules/test`

Evaluate one cancellation rule against sample text.

- Auth: `authenticated`
- Request body: required
  - Schema: `OrderCancellationRuleTestRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/pricing/cel-fbs`

Run the CEL FBS pricing calculator for a single input payload.

- Auth: `authenticated`
- Request body: required
  - Schema: `CelFbsPricingRequest`
- Responses:
  - `200` `application/json` -> `object`

### Synchronization

#### `POST /api/sync/ozon`

Run a full Ozon order synchronization for a requested date window.

- Auth: `authenticated`
- Request body: optional
  - Schema: `DateRangeSyncRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/sync/ozon/incremental`

Run an incremental Ozon order synchronization.

- Auth: `authenticated`
- Request body: optional
  - Schema: `DateRangeSyncRequest`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/sync/online-products`

Synchronize online-product snapshots from Ozon.

- Auth: `authenticated`
- Request body: optional
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/sync/ozon-stocks`

Synchronize Ozon stock snapshots and classifications.

- Auth: `authenticated`
- Request body: optional
  - Schema: `object`
- Responses:
  - `200` `application/json` -> `object`

#### `POST /api/sync/ozon-finance`

Synchronize Ozon finance transactions and derived profit data.

- Auth: `authenticated`
- Request body: optional
  - Schema: `DateRangeSyncRequest`
- Responses:
  - `200` `application/json` -> `object`
