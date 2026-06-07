/**
 * Backend API contract registry.
 *
 * The goals of this module are:
 * 1. Keep endpoint contracts centralized and machine-readable.
 * 2. Generate human-readable Markdown from the same source of truth.
 * 3. Make API changes auditable and enforceable through generated docs checks.
 */

const scalar = (type, description, extra = {}) => ({ kind: "scalar", type, description, ...extra });
const ref = (name, description = "") => ({ kind: "ref", ref: name, description });
const arrayOf = (item, description, extra = {}) => ({ kind: "array", items: item, description, ...extra });
const objectOf = (description, fields = [], extra = {}) => ({ kind: "object", description, fields, ...extra });
const field = (name, schema, required = false) => ({ name, required, ...schema });
const body = (schema, required = true, description = "") => ({ required, description, schema });
const param = (name, schema, required = true) => ({ name, required, ...schema });
const response = (status, mediaType, schema, description = "") => ({ status, mediaType, schema, description });

const schemas = {
  ApiCatalog: objectOf("Machine-readable API contract catalog.", [
    field("generatedAt", scalar("string", "Generation timestamp in ISO-8601.", { format: "date-time" }), true),
    field("title", scalar("string", "Catalog title."), true),
    field("overview", arrayOf(scalar("string", "Overview line."), "Shared conventions."), true),
    field("changePolicy", ref("ApiChangePolicy", "Mandatory change-management policy."), true),
    field("schemas", scalar("object", "Named reusable schema registry."), true),
    field("sections", arrayOf(scalar("object", "Endpoint group metadata."), "Endpoint groups."), true)
  ], { additionalProperties: false }),

  ApiChangePolicy: objectOf("System-level API documentation governance policy.", [
    field("tier", scalar("string", "Operational severity level. Current value is T0.", { enum: ["T0"] }), true),
    field("title", scalar("string", "Policy title."), true),
    field("requirements", arrayOf(scalar("string", "Mandatory rule."), "Mandatory rules for API changes."), true),
    field("enforcement", arrayOf(scalar("string", "Executable or review enforcement point."), "Enforcement steps."), true)
  ], { additionalProperties: false }),

  ErrorResponse: objectOf("Standard JSON error payload.", [
    field("error", scalar("string", "Human-readable error message."), true)
  ], { additionalProperties: false }),

  MutationOk: objectOf("Minimal mutation success payload.", [
    field("ok", scalar("boolean", "Whether the operation completed successfully."), true)
  ], { additionalProperties: false }),

  IdResponse: objectOf("Creation success payload.", [
    field("id", scalar("number", "Newly created record identifier."), true)
  ], { additionalProperties: false }),

  AuthUser: objectOf("Authenticated ERP user.", [
    field("id", scalar("number", "Internal person identifier."), true),
    field("name", scalar("string", "Display name."), true),
    field("role", scalar("string", "Authorization role such as admin or operator."), true),
    field("username", scalar("string", "Login username."), true)
  ], { additionalProperties: false }),

  AuthSession: objectOf("Login response for token-based API access.", [
    field("ok", scalar("boolean", "Whether login succeeded."), true),
    field("token", scalar("string", "Bearer token for later Authorization headers."), true),
    field("user", ref("AuthUser", "Authenticated user."), true)
  ], { additionalProperties: false }),

  LoginRequest: objectOf("Login payload.", [
    field("username", scalar("string", "Username to authenticate."), true),
    field("password", scalar("string", "Plain-text password."), true)
  ], { additionalProperties: false }),

  ChangePasswordRequest: objectOf("Password change payload.", [
    field("old_password", scalar("string", "Current password."), true),
    field("new_password", scalar("string", "New password."), true)
  ], { additionalProperties: false }),

  SystemInfo: objectOf("Runtime information about the current ERP instance.", [
    field("appVersion", scalar("string", "Application version or release marker.")),
    field("dbClient", scalar("string", "Active database client.")),
    field("database", objectOf("Active MySQL database connection summary.", [
      field("host", scalar("string", "MySQL host.")),
      field("port", scalar("number", "MySQL port.")),
      field("name", scalar("string", "MySQL database name.")),
      field("user", scalar("string", "MySQL user."))
    ])),
    field("host", scalar("string", "Server bind host.")),
    field("port", scalar("number", "Server bind port.")),
    field("appBaseUrl", scalar("string", "Browser-facing base URL."))
  ]),

  ScheduledJob: objectOf("Persisted background task schedule and latest execution state.", [
    field("id", scalar("number", "Scheduled job identifier.")),
    field("key", scalar("string", "Stable job key such as order_status_sync.")),
    field("name", scalar("string", "Human-readable job name.")),
    field("category", scalar("string", "Job category such as orders, advertising, inventory, listing, analytics, or maintenance.")),
    field("priority", scalar("string", "Execution priority such as critical, high, normal, or low.")),
    field("scheduleType", scalar("string", "Schedule type: interval or daily.")),
    field("intervalMinutes", scalar("number", "Interval in minutes for interval jobs.")),
    field("dailyTime", scalar("string", "Shanghai wall-clock time for daily jobs, HH:mm.")),
    field("enabled", scalar("boolean", "Whether the scheduler may run this job.")),
    field("catchupEnabled", scalar("boolean", "Whether missed runs may be recovered after downtime.")),
    field("config", scalar("object", "Optional task-specific runtime config such as timeout minutes or sync scope.")),
    field("lastSuccessAt", scalar("string", "Last successful run timestamp.", { format: "date-time" })),
    field("lastAttemptAt", scalar("string", "Last attempted run timestamp.", { format: "date-time" })),
    field("nextRunAt", scalar("string", "Next planned run timestamp.", { format: "date-time" })),
    field("failCount", scalar("number", "Consecutive failure count.")),
    field("lastStatus", scalar("string", "Latest run status.")),
    field("lastError", scalar("string", "Latest error message, if any.")),
    field("recentRuns", arrayOf(ref("ScheduledJobRun"), "Most recent run rows for this job."))
  ]),

  ScheduledJobRun: objectOf("One background task execution record.", [
    field("id", scalar("number", "Run identifier.")),
    field("jobKey", scalar("string", "Scheduled job key.")),
    field("plannedFor", scalar("string", "Planned execution timestamp.", { format: "date-time" })),
    field("startedAt", scalar("string", "Run start timestamp.", { format: "date-time" })),
    field("finishedAt", scalar("string", "Run finish timestamp.", { format: "date-time" })),
    field("status", scalar("string", "Run status: running, success, partial, failed, or skipped.")),
    field("mode", scalar("string", "Run source such as scheduled, manual, or catchup.")),
    field("payload", scalar("object", "Schedule payload captured when the run started.")),
    field("result", scalar("object", "Handler result payload for successful or skipped runs.")),
    field("errorMessage", scalar("string", "Failure message, if any."))
  ]),

  ScheduledJobRunRequest: objectOf("Manual scheduled-job run request.", [
    field("job_key", scalar("string", "Scheduled job key to run immediately."), true)
  ], { additionalProperties: false }),

  ScheduledJobStateRequest: objectOf("Scheduled-job enable or disable request.", [
    field("job_key", scalar("string", "Scheduled job key to update."), true),
    field("enabled", scalar("boolean", "Whether the job should be enabled."), true)
  ], { additionalProperties: false }),

  ScheduledJobConfigRequest: objectOf("Scheduled-job runtime configuration update request.", [
    field("job_key", scalar("string", "Scheduled job key to update."), true),
    field("scheduleType", scalar("string", "Schedule type: interval or daily.")),
    field("intervalMinutes", scalar("number", "Interval in minutes for interval jobs.")),
    field("dailyTime", scalar("string", "Shanghai wall-clock time for daily jobs, HH:mm.")),
    field("catchupEnabled", scalar("boolean", "Whether missed runs may be recovered after downtime.")),
    field("maxCatchupRuns", scalar("number", "Maximum backfill runs allowed when recovering.")),
    field("config", scalar("object", "Task-specific config patch such as timeout minutes, scope, or days."))
  ], { additionalProperties: false }),

  ExchangeRate: objectOf("CNY to RUB exchange-rate row.", [
    field("id", scalar("number", "Rate record identifier.")),
    field("currency_from", scalar("string", "Base currency code.")),
    field("currency_to", scalar("string", "Target currency code.")),
    field("rate", scalar("number", "Conversion rate.")),
    field("source", scalar("string", "Rate source such as manual or fallback.")),
    field("effective_date", scalar("string", "Date when the rate becomes effective.", { format: "date" })),
    field("note", scalar("string", "Operator note."))
  ]),

  ExchangeRateUpdateRequest: objectOf("Create a manual exchange rate record.", [
    field("rate", scalar("number", "New positive conversion rate."), true),
    field("source", scalar("string", "Optional source label such as manual.")),
    field("effective_date", scalar("string", "Optional effective date in YYYY-MM-DD.", { format: "date" })),
    field("note", scalar("string", "Optional note."))
  ], { additionalProperties: false }),

  ShopRecord: objectOf("ERP shop configuration row.", [
    field("id", scalar("number", "Shop identifier.")),
    field("name", scalar("string", "Shop display name.")),
    field("legal_entity", scalar("string", "Legal entity or company name.")),
    field("ozon_client_id", scalar("string", "Ozon client identifier.")),
    field("api_key_hint", scalar("string", "Non-sensitive API key hint.")),
    field("status", scalar("string", "Shop status.")),
    field("payout_rate", scalar("number", "Settlement payout ratio.")),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" }))
  ]),

  ShopMutationRequest: objectOf("Create or update shop payload.", [
    field("name", scalar("string", "Shop display name."), true),
    field("legal_entity", scalar("string", "Legal entity or company name.")),
    field("ozon_client_id", scalar("string", "Ozon client identifier.")),
    field("api_key_hint", scalar("string", "Displayed API key hint only.")),
    field("status", scalar("string", "Shop status such as active or inactive.")),
    field("payout_rate", scalar("number", "Settlement payout ratio."))
  ], { additionalProperties: false }),

  PersonRecord: objectOf("ERP person or operator record.", [
    field("id", scalar("number", "Person identifier.")),
    field("name", scalar("string", "Display name.")),
    field("username", scalar("string", "Login username.")),
    field("role", scalar("string", "Authorization role.")),
    field("avatar_url", scalar("string", "Optional avatar URL.")),
    field("active", scalar("number", "Whether the person is active."))
  ]),

  PersonMutationRequest: objectOf("Create or update person payload.", [
    field("name", scalar("string", "Display name."), true),
    field("username", scalar("string", "Login username.")),
    field("password", scalar("string", "Optional initial password for creation or reset.")),
    field("role", scalar("string", "Authorization role such as operator or admin.")),
    field("avatar_url", scalar("string", "Optional avatar URL.")),
    field("active", scalar("number", "Whether the person is active."))
  ], { additionalProperties: false }),

  SupplierRecord: objectOf("Supplier master-data row.", [
    field("id", scalar("number", "Supplier identifier.")),
    field("name", scalar("string", "Supplier name.")),
    field("contact_person", scalar("string", "Primary contact person.")),
    field("contact_phone", scalar("string", "Primary contact phone.")),
    field("wechat_id", scalar("string", "WeChat identifier.")),
    field("business_note", scalar("string", "Business note.")),
    field("status", scalar("string", "Supplier status.")),
    field("product_count", scalar("number", "Number of active linked products."))
  ]),

  SupplierMutationRequest: objectOf("Create or update supplier payload.", [
    field("name", scalar("string", "Supplier name."), true),
    field("contact_person", scalar("string", "Primary contact person.")),
    field("contact_phone", scalar("string", "Primary contact phone.")),
    field("wechat_id", scalar("string", "WeChat identifier.")),
    field("business_note", scalar("string", "Business note."))
  ], { additionalProperties: false }),

  ProductRecord: objectOf("Selection or inventory product with computed business metrics.", [
    field("id", scalar("number", "Product identifier.")),
    field("selection_id", scalar("string", "Legacy selection identifier.")),
    field("code", scalar("string", "Stable internal product code.")),
    field("inventory_id", scalar("string", "Derived display inventory code.")),
    field("name", scalar("string", "Product name.")),
    field("image_url", scalar("string", "Product image URL or data URI.")),
    field("purchase_url", scalar("string", "Procurement link.")),
    field("shipping_method", scalar("string", "Preferred shipping method.")),
    field("purchase_cost", scalar("number", "Unit purchase cost.")),
    field("owner_person_id", scalar("number", "Assigned owner identifier.")),
    field("owner_name", scalar("string", "Assigned owner display name.")),
    field("supplier_id", scalar("number", "Linked supplier identifier.")),
    field("stock", scalar("number", "Posted local stock balance.")),
    field("incoming_stock", scalar("number", "Expected inbound stock.")),
    field("avg_unit_cost", scalar("number", "Average unit cost.")),
    field("avg_sale_price", scalar("number", "Average realized sale price.")),
    field("avg_profit", scalar("number", "Average estimated profit per sold unit.")),
    field("estimated_profit_total", scalar("number", "Total estimated profit for sold items.")),
    field("actual_profit_total", scalar("number", "Total accrued actual profit for sold items.")),
    field("profit_rate", scalar("number", "Average profit ratio.")),
    field("order_count", scalar("number", "Distinct order count.")),
    field("sku_count", scalar("number", "Count of active mapped SKUs.")),
    field("mapped_skus", scalar("string", "Comma-separated mapped Ozon SKUs.")),
    field("active", scalar("number", "Whether the product is active.")),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" })),
    field("updated_at", scalar("string", "Last update timestamp.", { format: "date-time" }))
  ]),

  ProductMutationRequest: objectOf("Create or update product payload.", [
    field("selection_id", scalar("string", "Optional legacy selection identifier.")),
    field("code", scalar("string", "Stable internal product code.")),
    field("name", scalar("string", "Product name."), true),
    field("image_url", scalar("string", "Product image URL or data URI.")),
    field("purchase_url", scalar("string", "Procurement link.")),
    field("supplier_note", scalar("string", "Supplier note.")),
    field("source_platform", scalar("string", "Procurement source platform.")),
    field("shipping_method", scalar("string", "Preferred shipping method.")),
    field("recommended_shipping_method", scalar("string", "Recommended shipping method.")),
    field("purchase_cost", scalar("number", "Unit purchase cost.")),
    field("domestic_shipping", scalar("number", "Domestic shipping cost.")),
    field("handling_fee", scalar("number", "Handling or packaging fee.")),
    field("purchase_quantity", scalar("number", "Recommended procurement quantity.")),
    field("package_weight_g", scalar("number", "Package weight in grams.")),
    field("length_cm", scalar("number", "Package length in centimeters.")),
    field("width_cm", scalar("number", "Package width in centimeters.")),
    field("height_cm", scalar("number", "Package height in centimeters.")),
    field("listing_price_rub", scalar("number", "Suggested listing price in RUB.")),
    field("air_sale_price_rmb", scalar("number", "Reference sale price in RMB.")),
    field("exchange_rate", scalar("number", "Reference exchange rate.")),
    field("target_margin", scalar("number", "Target margin ratio.")),
    field("desired_profit_mode", scalar("string", "Desired profit mode.")),
    field("desired_profit_value", scalar("number", "Desired profit value.")),
    field("return_rate", scalar("number", "Expected return rate.")),
    field("payment_fee_rate", scalar("number", "Payment fee rate.")),
    field("withdrawal_fee_rate", scalar("number", "Withdrawal fee rate.")),
    field("owner_person_id", scalar("number", "Assigned owner identifier.")),
    field("created_by_person_id", scalar("number", "Creator identifier.")),
    field("product_type", scalar("string", "Product type such as main or accessory.")),
    field("parent_product_id", scalar("number", "Parent product identifier.")),
    field("accessory_note", scalar("string", "Accessory note.")),
    field("selection_status", scalar("string", "Selection lifecycle status.")),
    field("alert_stock", scalar("number", "Local stock warning threshold.")),
    field("supplier_id", scalar("number", "Linked supplier identifier.")),
    field("active", scalar("number", "Whether the product is active."))
  ], { additionalProperties: false }),

  ProductCreateResponse: objectOf("Product creation response.", [
    field("id", scalar("number", "New product identifier."), true),
    field("product", ref("ProductRecord", "Enriched product detail after creation."), true)
  ], { additionalProperties: false }),

  ProductImportPreviewRequest: objectOf("Product CSV import preview payload.", [
    field("csv_text", scalar("string", "Raw CSV content."), true),
    field("delimiter", scalar("string", "Optional CSV delimiter override."))
  ], { additionalProperties: false }),

  ProductImportPreviewResponse: objectOf("Import preview result.", [
    field("rows", arrayOf(scalar("object", "Parsed import row."), "Parsed rows."), true),
    field("errors", arrayOf(scalar("object", "Validation issue."), "Validation issues."), true)
  ]),

  ProductImportCommitRequest: objectOf("Commit a validated product import batch.", [
    field("rows", arrayOf(scalar("object", "Validated row ready to insert."), "Rows to persist."), true)
  ], { additionalProperties: false }),

  OnlineProductRecord: objectOf("Ozon online product or SKU snapshot.", [
    field("id", scalar("number", "Online product identifier.")),
    field("shop_id", scalar("number", "Owning shop identifier.")),
    field("product_id", scalar("number", "Linked ERP product identifier.")),
    field("ozon_sku", scalar("string", "Ozon SKU.")),
    field("offer_id", scalar("string", "Seller offer identifier.")),
    field("name", scalar("string", "Product title from Ozon.")),
    field("image_url", scalar("string", "Image URL.")),
    field("primary_image", scalar("string", "Primary image URL.")),
    field("sale_price", scalar("number", "Current sale price.")),
    field("currency_code", scalar("string", "Price currency code.")),
    field("status", scalar("string", "Lifecycle status on Ozon.")),
    field("visibility", scalar("string", "Storefront visibility state.")),
    field("archived", scalar("number", "Whether the item is archived.")),
    field("is_discounted", scalar("number", "Whether the item is discounted.")),
    field("synced_at", scalar("string", "Last synchronization timestamp.", { format: "date-time" })),
    field("updated_at", scalar("string", "Last local update timestamp.", { format: "date-time" }))
  ]),

  OnlineProductMutationRequest: objectOf("Create or update a local online-product record.", [
    field("shop_id", scalar("number", "Owning shop identifier."), true),
    field("ozon_sku", scalar("string", "Ozon SKU."), true),
    field("offer_id", scalar("string", "Seller offer identifier.")),
    field("name", scalar("string", "Product title."), true),
    field("image_url", scalar("string", "Image URL.")),
    field("primary_image", scalar("string", "Primary image URL.")),
    field("sale_price", scalar("number", "Current sale price.")),
    field("currency_code", scalar("string", "Price currency code.")),
    field("status", scalar("string", "Lifecycle status.")),
    field("visibility", scalar("string", "Storefront visibility state.")),
    field("archived", scalar("number", "Whether the item is archived.")),
    field("is_discounted", scalar("number", "Whether the item is discounted.")),
    field("product_id", scalar("number", "Linked ERP product identifier."))
  ], { additionalProperties: false }),

  OnlineProductBindRequest: objectOf("Bind an online product to ERP inventory ownership.", [
    field("online_product_id", scalar("number", "Local online product identifier."), true),
    field("product_id", scalar("number", "ERP product identifier."), true),
    field("person_id", scalar("number", "Responsible owner identifier.")),
    field("shop_id", scalar("number", "Shop identifier.")),
    field("ozon_sku", scalar("string", "Ozon SKU.")),
    field("offer_id", scalar("string", "Offer identifier."))
  ], { additionalProperties: false }),

  OnlineProductActionRequest: objectOf("Managed Ozon online-product action request.", [
    field("online_product_id", scalar("number", "Local online product identifier."), true),
    field("action_type", scalar("string", "Action type such as zero_stock or archive."), true),
    field("warehouse_id", scalar("string", "Optional target warehouse identifier.")),
    field("payload", scalar("object", "Action-specific payload."))
  ], { additionalProperties: false }),

  OzonWarehouseRecord: objectOf("Ozon seller warehouse record.", [
    field("warehouse_id", scalar("string", "Ozon warehouse identifier."), true),
    field("name", scalar("string", "Warehouse display name.")),
    field("status", scalar("string", "Warehouse status.")),
    field("delivery_schema", scalar("string", "Delivery schema such as fbs or rfbs."))
  ]),

  OnlineProductWarehousesResponse: objectOf("Warehouses available for a shop.", [
    field("shop_id", scalar("number", "Shop identifier."), true),
    field("shop_name", scalar("string", "Shop display name.")),
    field("warehouses", arrayOf(ref("OzonWarehouseRecord"), "Ozon warehouses."), true)
  ]),

  OnlineProductBatchStockRequest: objectOf("Bulk stock update for selected online products.", [
    field("online_product_ids", arrayOf(scalar("number", "Online product identifier."), "Selected online product ids."), true),
    field("shop_id", scalar("number", "Target shop identifier.")),
    field("warehouse_id", scalar("string", "Target Ozon warehouse identifier."), true),
    field("stock", scalar("number", "Stock quantity to set. Defaults to 888."))
  ], { additionalProperties: false }),

  OnlineProductBatchStockResponse: objectOf("Bulk Ozon stock update result.", [
    field("ok", scalar("boolean", "Whether the operation succeeded."), true),
    field("shop_id", scalar("number", "Target shop identifier.")),
    field("warehouse_id", scalar("string", "Target Ozon warehouse identifier.")),
    field("stock", scalar("number", "Submitted stock quantity.")),
    field("requested_count", scalar("number", "Number of selected online products.")),
    field("target_count", scalar("number", "Number of submitted Ozon stock targets.")),
    field("skipped", arrayOf(scalar("object", "Skipped online-product summary."), "Skipped rows."))
  ]),

  CreateProductFromOnlineProductRequest: objectOf("Create an ERP product from an online product.", [
    field("online_product_id", scalar("number", "Local online product identifier."), true),
    field("owner_person_id", scalar("number", "Assigned owner identifier.")),
    field("supplier_id", scalar("number", "Linked supplier identifier."))
  ], { additionalProperties: false }),

  SkuMappingRecord: objectOf("Mapping from Ozon SKU to ERP product ownership.", [
    field("id", scalar("number", "Mapping identifier.")),
    field("shop_id", scalar("number", "Owning shop identifier.")),
    field("product_id", scalar("number", "ERP product identifier.")),
    field("person_id", scalar("number", "Responsible person identifier.")),
    field("online_product_id", scalar("number", "Linked online product identifier.")),
    field("ozon_sku", scalar("string", "Mapped Ozon SKU.")),
    field("offer_id", scalar("string", "Offer identifier.")),
    field("display_name", scalar("string", "Optional display label.")),
    field("commission_low", scalar("number", "Lower commission estimate.")),
    field("commission_high", scalar("number", "Upper commission estimate.")),
    field("active", scalar("number", "Whether the mapping is active."))
  ]),

  SkuMappingMutationRequest: objectOf("Create or update a SKU mapping.", [
    field("shop_id", scalar("number", "Owning shop identifier.")),
    field("product_id", scalar("number", "ERP product identifier.")),
    field("person_id", scalar("number", "Responsible owner identifier.")),
    field("online_product_id", scalar("number", "Linked online product identifier.")),
    field("ozon_sku", scalar("string", "Mapped Ozon SKU."), true),
    field("offer_id", scalar("string", "Offer identifier.")),
    field("display_name", scalar("string", "Optional display label.")),
    field("commission_low", scalar("number", "Lower commission estimate.")),
    field("commission_high", scalar("number", "Upper commission estimate.")),
    field("active", scalar("number", "Whether the mapping is active."))
  ], { additionalProperties: false }),

  OrderListItem: objectOf("Flattened order row used by list and workbench pages.", [
    field("id", scalar("number", "Order identifier.")),
    field("shop_id", scalar("number", "Owning shop identifier.")),
    field("shop_name", scalar("string", "Owning shop name.")),
    field("posting_number", scalar("string", "Ozon posting number.")),
    field("order_number", scalar("string", "Ozon order number.")),
    field("status", scalar("string", "Normalized order status.")),
    field("tracking_stage", scalar("string", "Current tracking stage.")),
    field("logistics_status", scalar("string", "Carrier-facing logistics status.")),
    field("ordered_at", scalar("string", "Order timestamp.", { format: "date-time" })),
    field("delivered_at", scalar("string", "Delivery timestamp when available.", { format: "date-time" })),
    field("tracking_number", scalar("string", "Tracking number.")),
    field("item_count", scalar("number", "Distinct line count.")),
    field("total_quantity", scalar("number", "Summed line quantity.")),
    field("revenue", scalar("number", "Gross sale amount.")),
    field("estimated_profit", scalar("number", "Estimated profit total.")),
    field("actual_profit", scalar("number", "Accrued profit total.")),
    field("product_codes", scalar("string", "Comma-separated mapped product codes.")),
    field("product_names", scalar("string", "Comma-separated mapped product names.")),
    field("skus", scalar("string", "Comma-separated Ozon SKUs.")),
    field("mark_type", scalar("string", "Operator mark type.")),
    field("mark_note", scalar("string", "Operator mark note.")),
    field("printed_at", scalar("string", "Package label print timestamp.", { format: "date-time" })),
    field("delivery_method_name", scalar("string", "Resolved delivery method name.")),
    field("warehouse_name", scalar("string", "Resolved warehouse name.")),
    field("shipment_deadline_at", scalar("string", "Shipment SLA deadline.", { format: "date-time" })),
    field("ship_days_remaining", scalar("number", "Days remaining before SLA breach.")),
    field("is_overdue", scalar("boolean", "Whether the shipment deadline has passed."))
  ]),

  OrderDetailResponse: objectOf("Detailed order payload with line items and finance breakdown.", [
    field("order", ref("OrderListItem", "Order header and computed logistics state."), true),
    field("items", arrayOf(scalar("object", "Order line with profit, ownership, and dimension fields."), "Order lines."), true),
    field("finance", arrayOf(scalar("object", "Finance grouping row."), "Finance grouping rows."), true)
  ], { additionalProperties: false }),

  OrdersPagedResponse: objectOf("Paginated order list response.", [
    field("rows", arrayOf(ref("OrderListItem"), "Current page of orders."), true),
    field("total", scalar("number", "Total matching order count."), true),
    field("page", scalar("number", "Current page number."), true),
    field("pageSize", scalar("number", "Requested page size."), true),
    field("counts", scalar("object", "Status bucket counts used by tabs."), true),
    field("mode", scalar("string", "Response mode. Current value is paged."), true)
  ], { additionalProperties: false }),

  OrderQuery: objectOf("Order list query model.", [
    field("paged", scalar("boolean", "When true, return paged mode.")),
    field("page", scalar("number", "1-based page number.")),
    field("pageSize", scalar("number", "Page size, max 100.")),
    field("shopId", scalar("string", "Shop identifier or all.")),
    field("dateFrom", scalar("string", "Inclusive start date.", { format: "date" })),
    field("dateTo", scalar("string", "Inclusive end date.", { format: "date" })),
    field("status", scalar("string", "Status tab key.")),
    field("markFilter", scalar("string", "Mark filter key.")),
    field("printFilter", scalar("string", "Print-state filter key.")),
    field("searchType", scalar("string", "Search type such as order, tracking, sku, offer, product.")),
    field("searchQuery", scalar("string", "Search text.")),
    field("sortMode", scalar("string", "Sort mode key."))
  ]),

  OrderMarkRequest: objectOf("Set or clear an operator mark.", [
    field("mark_type", scalar("string", "Mark type. Empty with empty note clears the mark.")),
    field("note", scalar("string", "Optional mark note."))
  ], { additionalProperties: false }),

  OrderIdsRequest: objectOf("Payload for bulk order actions.", [
    field("order_ids", arrayOf(scalar("number", "Order identifier."), "Target order identifiers.", { minItems: 1 }), true)
  ], { additionalProperties: false }),

  ShipOrdersRequest: objectOf("Shipment confirmation payload.", [
    field("order_ids", arrayOf(scalar("number", "Order identifier."), "Target order identifiers.", { minItems: 1 }), true),
    field("tracking_number", scalar("string", "Optional shared tracking number.")),
    field("carrier", scalar("string", "Optional carrier label.")),
    field("payload", scalar("object", "Optional transport-specific fields."))
  ], { additionalProperties: false }),

  OrderQualityRulesResponse: objectOf("Quality-rule list payload.", [
    field("rules", arrayOf(scalar("object", "Rule row."), "Resolved rules.")),
    field("ok", scalar("boolean", "Whether the save operation completed."))
  ]),

  OrderQualityRulesRequest: objectOf("Bulk quality-rule replacement payload.", [
    field("prefixes", arrayOf(scalar("string", "Posting prefix."), "Active quality-check prefixes.")),
    field("note", scalar("string", "Shared rule note."))
  ], { additionalProperties: false }),

  DashboardResponse: objectOf("Dashboard overview for first-page business monitoring.", [
    field("summary", scalar("object", "Global revenue and profit counters."), true),
    field("commerce", scalar("object", "Dashboard commerce overview blocks.")),
    field("alerts", scalar("object", "Dashboard alert collections including procurement, FBP, and scheduled jobs.")),
    field("byShop", arrayOf(scalar("object", "Per-shop KPI row."), "Grouped by shop."), true),
    field("byPerson", arrayOf(scalar("object", "Per-person KPI row."), "Grouped by owner."), true),
    field("lowStock", arrayOf(scalar("object", "Low-stock product row."), "Low local stock products."), true),
    field("exceptions", arrayOf(scalar("object", "Open exception-count row."), "Open exception counts by type."), true),
    field("orderStages", arrayOf(scalar("object", "Order-stage row."), "Order counts by tracking stage."), true),
    field("stockByOwner", arrayOf(scalar("object", "Stock by owner row."), "Stock grouped by product and owner."), true)
  ], { additionalProperties: false }),

  ProfitSummaryResponse: objectOf("Profit aggregates by summary, shop, SKU, and product.", [
    field("summary", scalar("object", "Overall revenue, profit, cancellation, and return metrics."), true),
    field("byShop", arrayOf(scalar("object", "Per-shop profit rollup."), "Per-shop rows."), true),
    field("bySku", arrayOf(scalar("object", "Per-SKU profit rollup."), "Per-SKU rows."), true),
    field("byProduct", arrayOf(scalar("object", "Per-product profit rollup."), "Per-product rows."), true)
  ], { additionalProperties: false }),

  ProfitFiltersQuery: objectOf("Common profit filter query model.", [
    field("from", scalar("string", "Inclusive start date.", { format: "date" })),
    field("to", scalar("string", "Inclusive end date.", { format: "date" })),
    field("refresh", scalar("boolean", "Whether to force snapshot refresh.")),
    field("shopId", scalar("string", "Optional shop filter.")),
    field("groupBy", scalar("string", "Optional grouping key.")),
    field("metric", scalar("string", "Optional metric selector.")),
    field("page", scalar("number", "Optional page number.")),
    field("pageSize", scalar("number", "Optional page size."))
  ]),

  ProfitDashboardResponse: objectOf("Chart-ready profit dashboard payload.", [
    field("filters", scalar("object", "Resolved date and grouping filters.")),
    field("summary", scalar("object", "Top-level KPI cards.")),
    field("trend", arrayOf(scalar("object", "Time-series row."), "Chart rows.")),
    field("ranking", arrayOf(scalar("object", "Ranking row."), "Ranking rows."))
  ]),

  HistoricalProfitReviewResponse: objectOf("Historical profit review workbench payload.", [
    field("summary", scalar("object", "KPI summary for the review window."), true),
    field("rows", arrayOf(scalar("object", "Review candidate row."), "Review rows."), true),
    field("filters", scalar("object", "Resolved query filters."), true)
  ], { additionalProperties: false }),

  HistoricalProfitReviewActionRequest: objectOf("Apply manual review actions to historical profit rows.", [
    field("action", scalar("string", "Action key such as keep, clear, recalculate, or reset."), true),
    field("order_item_ids", arrayOf(scalar("number", "Order item identifier."), "Target order item identifiers.", { minItems: 1 }), true),
    field("note", scalar("string", "Optional operator note."))
  ], { additionalProperties: false }),

  ExceptionWorkbenchResponse: objectOf("Exception workbench payload for issue triage.", [
    field("generatedAt", scalar("string", "Server-side generation timestamp.", { format: "date-time" }), true),
    field("view", scalar("string", "Resolved workbench view key."), true),
    field("summary", scalar("object", "Top-level count summary."), true),
    field("counts", scalar("object", "Open issue counts by category."), true),
    field("rows", arrayOf(scalar("object", "Current page of exception tasks."), "Current page of tasks."), true),
    field("pagination", scalar("object", "Pagination state."), true)
  ], { additionalProperties: false }),

  ExceptionWorkbenchQuery: objectOf("Exception workbench query model.", [
    field("view", scalar("string", "Exception tab key.")),
    field("search", scalar("string", "Search text.")),
    field("page", scalar("number", "1-based page number.")),
    field("pageSize", scalar("number", "Page size, max 200.")),
    field("sortField", scalar("string", "Sort field key.")),
    field("sortDirection", scalar("string", "Sort direction key.")),
    field("dateFrom", scalar("string", "Inclusive start date.", { format: "date" })),
    field("dateTo", scalar("string", "Inclusive end date.", { format: "date" })),
    field("refresh", scalar("boolean", "Force rebuild the cached workbench view."))
  ]),

  ExceptionTaskStateRequest: objectOf("Persist manual task state.", [
    field("task_id", scalar("string", "Stable task identifier."), true),
    field("status", scalar("string", "Desired task state such as open, handled, or ignored."), true),
    field("note", scalar("string", "Optional operator note."))
  ], { additionalProperties: false }),

  DateRangeSyncRequest: objectOf("Date-range sync payload.", [
    field("from", scalar("string", "Inclusive start date in YYYY-MM-DD.", { format: "date" })),
    field("to", scalar("string", "Inclusive end date in YYYY-MM-DD.", { format: "date" })),
    field("shop_id", scalar("number", "Optional target shop identifier.")),
    field("force", scalar("boolean", "Whether to bypass light guards.")),
    field("limit", scalar("number", "Optional sync item limit."))
  ], { additionalProperties: false }),

  InventorySnapshot: arrayOf(scalar("object", "Inventory overview row."), "Inventory rows with product, quantity, owner, and computed stock state."),
  StockAlertsResponse: arrayOf(scalar("object", "Stock alert row."), "Inventory alert rows with warning badges and replenishment suggestions."),

  InventoryMovementRequest: objectOf("Manual inventory movement payload.", [
    field("product_id", scalar("number", "Target product identifier."), true),
    field("shop_id", scalar("number", "Related shop identifier.")),
    field("sku_mapping_id", scalar("number", "Related SKU mapping identifier.")),
    field("owner_person_id", scalar("number", "Owner identifier.")),
    field("source_type", scalar("string", "Movement source type."), true),
    field("source_ref", scalar("string", "External source reference.")),
    field("quantity_delta", scalar("number", "Positive or negative stock delta."), true),
    field("unit_cost", scalar("number", "Unit cost.")),
    field("amount", scalar("number", "Total amount.")),
    field("status", scalar("string", "Movement status.")),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  ProcurementRequestRecord: objectOf("Procurement request row.", [
    field("id", scalar("number", "Request identifier.")),
    field("product_id", scalar("number", "Target product identifier.")),
    field("person_id", scalar("number", "Requester or owner identifier.")),
    field("quantity", scalar("number", "Requested quantity.")),
    field("amount", scalar("number", "Merchandise amount.")),
    field("shipping_amount", scalar("number", "Estimated shipping amount.")),
    field("supplier_id", scalar("number", "Selected supplier identifier.")),
    field("approval_status", scalar("string", "Approval status.")),
    field("status", scalar("string", "Request execution status.")),
    field("needed_by", scalar("string", "Needed-by date.", { format: "date" })),
    field("note", scalar("string", "Operator note.")),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" }))
  ]),

  ProcurementRequestMutationRequest: objectOf("Create or update a procurement request.", [
    field("product_id", scalar("number", "Target product identifier."), true),
    field("person_id", scalar("number", "Requester or owner identifier.")),
    field("quantity", scalar("number", "Requested quantity."), true),
    field("amount", scalar("number", "Merchandise amount.")),
    field("shipping_amount", scalar("number", "Estimated shipping amount.")),
    field("purchase_url", scalar("string", "Procurement link.")),
    field("source_type", scalar("string", "Procurement source type.")),
    field("supplier_id", scalar("number", "Selected supplier identifier.")),
    field("approval_status", scalar("string", "Approval status.")),
    field("status", scalar("string", "Request execution status.")),
    field("needed_by", scalar("string", "Needed-by date.", { format: "date" })),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  ProcurementSubmitRequest: objectOf("Bulk procurement submit payload.", [
    field("request_ids", arrayOf(scalar("number", "Procurement request identifier."), "Target request identifiers.", { minItems: 1 }), true),
    field("note", scalar("string", "Optional batch note."))
  ], { additionalProperties: false }),

  PurchaseOrderRecord: objectOf("Aggregated purchase-order header.", [
    field("id", scalar("number", "Purchase-order identifier.")),
    field("supplier_id", scalar("number", "Supplier identifier.")),
    field("status", scalar("string", "Purchase-order status.")),
    field("item_count", scalar("number", "Number of merged request lines.")),
    field("total_quantity", scalar("number", "Summed quantity.")),
    field("total_amount", scalar("number", "Summed purchase amount.")),
    field("purchased_at", scalar("string", "Purchase confirmation timestamp.", { format: "date-time" })),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" }))
  ]),

  MergePurchaseOrdersRequest: objectOf("Merge procurement requests into a purchase order.", [
    field("request_ids", arrayOf(scalar("number", "Procurement request identifier."), "Request identifiers to merge.", { minItems: 1 }), true),
    field("supplier_id", scalar("number", "Supplier identifier.")),
    field("note", scalar("string", "Optional purchase-order note."))
  ], { additionalProperties: false }),

  PurchaseOrderMutationRequest: objectOf("Update a purchase order.", [
    field("supplier_id", scalar("number", "Supplier identifier.")),
    field("status", scalar("string", "Purchase-order status.")),
    field("note", scalar("string", "Operator note.")),
    field("purchase_url", scalar("string", "Optional procurement link."))
  ], { additionalProperties: false }),

  PurchaseOrderConfirmRequest: objectOf("Confirm purchase-order purchase.", [
    field("purchased_at", scalar("string", "Purchase timestamp.", { format: "date-time" })),
    field("note", scalar("string", "Optional operator note."))
  ], { additionalProperties: false }),

  InboundRecord: objectOf("Inbound shipment or arrival record.", [
    field("id", scalar("number", "Inbound record identifier.")),
    field("product_id", scalar("number", "Product identifier.")),
    field("person_id", scalar("number", "Owner or operator identifier.")),
    field("quantity", scalar("number", "Inbound quantity.")),
    field("amount", scalar("number", "Inbound merchandise amount.")),
    field("unit_cost", scalar("number", "Unit cost.")),
    field("shipping_amount", scalar("number", "Shipping amount.")),
    field("status", scalar("string", "Inbound status.")),
    field("note", scalar("string", "Operator note.")),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" })),
    field("approved_at", scalar("string", "Approval timestamp.", { format: "date-time" }))
  ]),

  InboundRecordMutationRequest: objectOf("Create or update an inbound record.", [
    field("product_id", scalar("number", "Product identifier."), true),
    field("person_id", scalar("number", "Owner or operator identifier.")),
    field("quantity", scalar("number", "Inbound quantity."), true),
    field("amount", scalar("number", "Inbound merchandise amount.")),
    field("unit_cost", scalar("number", "Unit cost.")),
    field("shipping_amount", scalar("number", "Shipping amount.")),
    field("purchase_url", scalar("string", "Procurement link.")),
    field("status", scalar("string", "Inbound status.")),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  OutboundRecord: objectOf("Outbound stock deduction row.", [
    field("id", scalar("number", "Outbound record identifier.")),
    field("product_id", scalar("number", "Product identifier.")),
    field("shop_id", scalar("number", "Shop identifier.")),
    field("online_product_id", scalar("number", "Online product identifier.")),
    field("order_ref", scalar("string", "Reference order number.")),
    field("person_id", scalar("number", "Responsible person identifier.")),
    field("quantity", scalar("number", "Deducted quantity.")),
    field("reason", scalar("string", "Deduction reason.")),
    field("status", scalar("string", "Outbound status.")),
    field("note", scalar("string", "Operator note.")),
    field("created_at", scalar("string", "Creation timestamp.", { format: "date-time" }))
  ]),

  LogisticsRule: objectOf("Logistics fee rule row.", [
    field("id", scalar("number", "Rule identifier.")),
    field("name", scalar("string", "Rule name.")),
    field("carrier", scalar("string", "Carrier name.")),
    field("channel", scalar("string", "Channel name.")),
    field("mode", scalar("string", "Pricing mode.")),
    field("min_weight_g", scalar("number", "Lower weight bound in grams.")),
    field("max_weight_g", scalar("number", "Upper weight bound in grams.")),
    field("base_fee_cny", scalar("number", "Base fee in CNY.")),
    field("per_gram_cny", scalar("number", "Per-gram fee in CNY.")),
    field("per_ticket_cny", scalar("number", "Per-ticket fee in CNY.")),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ]),

  LogisticsRuleMutationRequest: objectOf("Create or update a logistics fee rule.", [
    field("name", scalar("string", "Rule name."), true),
    field("carrier", scalar("string", "Carrier name.")),
    field("channel", scalar("string", "Channel name.")),
    field("mode", scalar("string", "Pricing mode.")),
    field("min_weight_g", scalar("number", "Lower weight bound in grams.")),
    field("max_weight_g", scalar("number", "Upper weight bound in grams.")),
    field("min_price_rub", scalar("number", "Lower listing-price bound in RUB.")),
    field("max_price_rub", scalar("number", "Upper listing-price bound in RUB.")),
    field("base_fee_cny", scalar("number", "Base fee in CNY.")),
    field("per_gram_cny", scalar("number", "Per-gram fee in CNY.")),
    field("per_ticket_cny", scalar("number", "Per-ticket fee in CNY.")),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  StockWarehouseRule: objectOf("Warehouse text-classification rule for Ozon stock snapshots.", [
    field("id", scalar("number", "Rule identifier.")),
    field("pattern", scalar("string", "Case-insensitive text pattern.")),
    field("stock_type", scalar("string", "Target stock type such as fbs_virtual or fbp_real.")),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ]),

  StockWarehouseRuleMutationRequest: objectOf("Create or update a stock warehouse classification rule.", [
    field("pattern", scalar("string", "Case-insensitive text pattern."), true),
    field("stock_type", scalar("string", "Target stock type such as fbs_virtual or fbp_real."), true),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  OrderCancellationRule: objectOf("Cancellation or return classification rule.", [
    field("id", scalar("number", "Rule identifier.")),
    field("name", scalar("string", "Rule name.")),
    field("match_text", scalar("string", "Matched text fragment.")),
    field("match_mode", scalar("string", "Matching mode such as contains.")),
    field("initiator_label", scalar("string", "Resolved initiator label.")),
    field("reason_label", scalar("string", "Resolved reason label.")),
    field("reason_code", scalar("string", "Stable reason code.")),
    field("reason_group_label", scalar("string", "Grouped reason label.")),
    field("accounting_hint", scalar("string", "Accounting interpretation hint.")),
    field("priority", scalar("number", "Lower values match first.")),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ]),

  OrderCancellationRuleMutationRequest: objectOf("Create or update a cancellation rule.", [
    field("name", scalar("string", "Rule name."), true),
    field("match_text", scalar("string", "Matched text fragment."), true),
    field("match_mode", scalar("string", "Matching mode such as contains.")),
    field("initiator_label", scalar("string", "Resolved initiator label.")),
    field("reason_label", scalar("string", "Resolved human-readable reason label.")),
    field("reason_code", scalar("string", "Stable reason code.")),
    field("reason_group_label", scalar("string", "Grouped reason label.")),
    field("accounting_hint", scalar("string", "Accounting interpretation hint.")),
    field("priority", scalar("number", "Priority order. Lower numbers match first.")),
    field("enabled", scalar("number", "Whether the rule is active.")),
    field("note", scalar("string", "Operator note."))
  ], { additionalProperties: false }),

  OrderCancellationRuleTestRequest: objectOf("Evaluate cancellation-rule matching.", [
    field("text", scalar("string", "Sample raw cancellation text."), true),
    field("status", scalar("string", "Optional order status sample.")),
    field("tracking_stage", scalar("string", "Optional tracking-stage sample."))
  ], { additionalProperties: false }),

  CelFbsPricingRequest: objectOf("Run the CEL FBS pricing calculator.", [
    field("sale_price_rub", scalar("number", "Listing or sale price in RUB."), true),
    field("weight_g", scalar("number", "Package weight in grams."), true),
    field("length_cm", scalar("number", "Package length in centimeters.")),
    field("width_cm", scalar("number", "Package width in centimeters.")),
    field("height_cm", scalar("number", "Package height in centimeters.")),
    field("exchange_rate", scalar("number", "CNY to RUB exchange rate.")),
    field("target_margin", scalar("number", "Target margin ratio."))
  ], { additionalProperties: false })
};

const changePolicy = {
  tier: "T0",
  title: "API Contract Change Rule",
  requirements: [
    "Any backend endpoint behavior change is a T0 system change.",
    "The endpoint definition in src/server/api-docs.js must be updated in the same change set.",
    "The generated file docs/BACKEND_API_REFERENCE.md must be regenerated in the same change set.",
    "Request schema, path params, query params, response schema, and auth mode must stay synchronized.",
    "If a response shape changes, the reusable schema entry must be updated instead of leaving drift in prose."
  ],
  enforcement: [
    "Run npm run docs:api after changing backend routes or service contracts.",
    "Run npm run docs:api:check before merge to ensure the committed Markdown matches generated output.",
    "Code review should reject API changes that do not update both the registry and the generated Markdown.",
    "Development tracker entries for system-level work must record this requirement as T0."
  ]
};

const endpoints = [
  section("Docs", [
    endpoint("GET", "/api/docs", "Return the machine-readable API catalog.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("ApiCatalog"))]
    }),
    endpoint("GET", "/api/docs/markdown", "Return the generated Markdown API reference.", {
      auth: "authenticated",
      responses: [response(200, "text/markdown", scalar("string", "Rendered Markdown API document."))]
    })
  ]),
  section("System", [
    endpoint("GET", "/api/system/info", "Return current runtime and deployment information.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("SystemInfo"))]
    }),
    endpoint("GET", "/api/scheduled-jobs", "Return persisted background task schedules with recent run status.", {
      auth: "authenticated",
      query: [
        param("run_limit", scalar("number", "Number of recent runs to include per job."), false)
      ],
      responses: [response(200, "application/json", arrayOf(ref("ScheduledJob"), "Scheduled background jobs."))]
    }),
    endpoint("GET", "/api/scheduled-job-runs", "Return background task execution history.", {
      auth: "authenticated",
      query: [
        param("job_key", scalar("string", "Optional scheduled job key filter."), false),
        param("limit", scalar("number", "Maximum number of run rows to return."), false)
      ],
      responses: [response(200, "application/json", arrayOf(ref("ScheduledJobRun"), "Scheduled job run history."))]
    }),
    endpoint("POST", "/api/scheduled-jobs/run", "Run one scheduled background task immediately and record the manual run.", {
      auth: "authenticated",
      requestBody: body(ref("ScheduledJobRunRequest")),
      responses: [response(200, "application/json", ref("ScheduledJob"))]
    }),
    endpoint("POST", "/api/scheduled-jobs/state", "Enable or disable a scheduled background task.", {
      auth: "authenticated",
      requestBody: body(ref("ScheduledJobStateRequest")),
      responses: [response(200, "application/json", ref("ScheduledJob"))]
    }),
    endpoint("POST", "/api/scheduled-jobs/config", "Update a scheduled background task runtime configuration.", {
      auth: "authenticated",
      requestBody: body(ref("ScheduledJobConfigRequest")),
      responses: [response(200, "application/json", ref("ScheduledJob"))]
    })
  ]),
  section("Auth", [
    endpoint("POST", "/api/auth/login", "Authenticate a user and return a bearer token.", {
      auth: "public",
      requestBody: body(ref("LoginRequest")),
      responses: [response(200, "application/json", ref("AuthSession")), response(429, "application/json", ref("ErrorResponse"), "Returned when login rate limit is exceeded.")]
    }),
    endpoint("GET", "/api/auth/me", "Resolve the current user from the bearer token.", {
      auth: "public",
      responses: [
        response(200, "application/json", ref("AuthUser"), "Returned when the token is valid."),
        response(200, "application/json", scalar("null", "Null when the token is missing, expired, or the user is inactive."), "Null response when not authenticated.")
      ]
    }),
    endpoint("POST", "/api/auth/logout", "Invalidate the current session token.", {
      auth: "public",
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/auth/change-password", "Change the current user's password.", {
      auth: "authenticated",
      requestBody: body(ref("ChangePasswordRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    })
  ]),
  section("Dashboard And Profit", [
    endpoint("GET", "/api/dashboard", "Return dashboard summary counters and grouped metrics.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("DashboardResponse"))]
    }),
    endpoint("GET", "/api/exchange-rate/current", "Return the latest effective CNY to RUB exchange rate.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("ExchangeRate"))]
    }),
    endpoint("GET", "/api/exchange-rates", "Return recent exchange-rate history.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ExchangeRate"), "Recent exchange-rate rows."))]
    }),
    endpoint("POST", "/api/exchange-rate", "Create a new manual exchange-rate record.", {
      auth: "authenticated",
      requestBody: body(ref("ExchangeRateUpdateRequest")),
      responses: [response(200, "application/json", ref("ExchangeRate"))]
    }),
    endpoint("GET", "/api/profit-summary", "Return aggregate profit metrics by summary, shop, SKU, and product.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ProfitFiltersQuery", ["from", "to", "refresh"]),
      responses: [response(200, "application/json", ref("ProfitSummaryResponse"))]
    }),
    endpoint("GET", "/api/profit-dashboard", "Return chart-ready profit dashboard data for the selected period.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ProfitFiltersQuery"),
      responses: [response(200, "application/json", ref("ProfitDashboardResponse"))]
    }),
    endpoint("GET", "/api/profit-ranking", "Return ranking rows for the selected profit dimension.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ProfitFiltersQuery"),
      responses: [response(200, "application/json", arrayOf(scalar("object", "Profit ranking row."), "Ranking rows."))]
    }),
    endpoint("GET", "/api/profit-details", "Return detailed profit rows for drill-down views.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ProfitFiltersQuery"),
      responses: [response(200, "application/json", arrayOf(scalar("object", "Profit detail row."), "Detailed rows."))]
    }),
    endpoint("GET", "/api/profits/historical-review", "Return historical profit review candidates and review state.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ProfitFiltersQuery"),
      responses: [response(200, "application/json", ref("HistoricalProfitReviewResponse"))]
    }),
    endpoint("POST", "/api/profits/historical-review/actions", "Apply an operator review action to historical profit rows.", {
      auth: "authenticated",
      requestBody: body(ref("HistoricalProfitReviewActionRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/profit-snapshots/refresh", "Refresh analytics snapshot tables used by profit dashboards.", {
      auth: "authenticated",
      requestBody: body(objectOf("Optional refresh scope.", [
        field("from", scalar("string", "Inclusive start date.", { format: "date" })),
        field("to", scalar("string", "Inclusive end date.", { format: "date" })),
        field("shop_id", scalar("number", "Optional shop filter."))
      ], { additionalProperties: false }), false),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/profits/recalculate-historical", "Recalculate historical order profit items for a selected scope.", {
      auth: "authenticated",
      requestBody: body(objectOf("Historical profit recalculation request.", [
        field("from", scalar("string", "Inclusive start date.", { format: "date" })),
        field("to", scalar("string", "Inclusive end date.", { format: "date" })),
        field("shop_id", scalar("number", "Optional shop filter.")),
        field("order_item_ids", arrayOf(scalar("number", "Order item identifier."), "Specific order-item identifiers to recalculate."))
      ], { additionalProperties: false })),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/profits/cleanup-delivered-return-loss", "Normalize delivered-return loss flags and derived profit data.", {
      auth: "authenticated",
      requestBody: body(objectOf("Delivered-return loss cleanup scope.", [
        field("from", scalar("string", "Inclusive start date.", { format: "date" })),
        field("to", scalar("string", "Inclusive end date.", { format: "date" })),
        field("shop_id", scalar("number", "Optional shop filter."))
      ], { additionalProperties: false }), false),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/ozon-finance/summary", "Return Ozon finance ingestion summary values.", {
      auth: "authenticated",
      responses: [response(200, "application/json", scalar("object", "Finance summary payload."))]
    })
  ]),
  section("Exception Workbench", [
    endpoint("GET", "/api/exception-workbench", "Return the current exception workbench task list and counts.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("ExceptionWorkbenchQuery"),
      responses: [response(200, "application/json", ref("ExceptionWorkbenchResponse"))]
    }),
    endpoint("POST", "/api/exception-workbench/sync", "Synchronize recent Ozon orders for the exception-workbench window.", {
      auth: "authenticated",
      responses: [response(200, "application/json", scalar("object", "Sync summary including sync window and counters."))]
    }),
    endpoint("POST", "/api/exception-workbench/tasks/state", "Persist manual task state such as open, resolved, and ignored.", {
      auth: "authenticated",
      requestBody: body(ref("ExceptionTaskStateRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    })
  ]),
  section("Orders", [
    endpoint("GET", "/api/orders", "Return the full order list or paged order list depending on the paged query flag.", {
      auth: "authenticated",
      query: queryFieldsFromSchema("OrderQuery"),
      responses: [
        response(200, "application/json", arrayOf(ref("OrderListItem"), "Full order list."), "Returned when paged is not set."),
        response(200, "application/json", ref("OrdersPagedResponse"), "Returned when paged=1 or paged=true.")
      ]
    }),
    endpoint("GET", "/api/orders/:id", "Return detailed information for a single order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Order identifier."))],
      responses: [response(200, "application/json", ref("OrderDetailResponse")), response(404, "application/json", ref("ErrorResponse"))]
    }),
    endpoint("PUT", "/api/orders/:id/mark", "Create, replace, or clear an operator mark for an order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Order identifier."))],
      requestBody: body(ref("OrderMarkRequest")),
      responses: [response(200, "application/json", scalar("object", "Saved mark payload."))]
    }),
    endpoint("POST", "/api/orders/package-label", "Generate a shipping label PDF for one or more orders.", {
      auth: "authenticated",
      requestBody: body(ref("OrderIdsRequest")),
      responses: [response(200, "application/pdf", scalar("binary", "Binary PDF document."))]
    }),
    endpoint("POST", "/api/orders/package-label-printed", "Mark one or more orders as label printed.", {
      auth: "authenticated",
      requestBody: body(ref("OrderIdsRequest")),
      responses: [response(200, "application/json", scalar("object", "Mutation result with count."))]
    }),
    endpoint("POST", "/api/orders/ship", "Submit shipment confirmation to Ozon for selected orders.", {
      auth: "authenticated",
      requestBody: body(ref("ShipOrdersRequest")),
      responses: [response(200, "application/json", scalar("object", "Shipment result summary."))]
    }),
    endpoint("POST", "/api/orders/:id/recalculate-profit", "Recalculate profit data for a single order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Order identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/orders/recalculate-profits", "Recalculate profit data for all mapped orders.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/order-quality-rules", "Return order quality-check prefix rules.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "Quality-rule row."), "Rule rows."))]
    }),
    endpoint("PUT", "/api/order-quality-rules", "Replace order quality-check prefix rules in bulk.", {
      auth: "authenticated",
      requestBody: body(ref("OrderQualityRulesRequest")),
      responses: [response(200, "application/json", ref("OrderQualityRulesResponse"))]
    })
  ]),
  section("Catalog", [
    endpoint("GET", "/api/products", "Return active product master data with inventory and profit metrics.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ProductRecord"), "Product rows."))]
    }),
    endpoint("GET", "/api/products/selection", "Return selection-facing product records.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ProductRecord"), "Selection product rows."))]
    }),
    endpoint("GET", "/api/products/hidden", "Return archived or hidden products.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ProductRecord"), "Hidden product rows."))]
    }),
    endpoint("GET", "/api/products/:id", "Return one product with full computed detail.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", ref("ProductRecord")), response(404, "application/json", ref("ErrorResponse"))]
    }),
    endpoint("GET", "/api/products/:id/image", "Return the stored product image binary.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "image/*", scalar("binary", "Binary image payload.")), response(404, "application/json", ref("ErrorResponse"))]
    }),
    endpoint("GET", "/api/products/:id/order-profit-details", "Return per-order profit rows for a product.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", arrayOf(scalar("object", "Product profit detail row."), "Detail rows."))]
    }),
    endpoint("GET", "/api/products/:id/cancel-details", "Return cancellation and return details for a product.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", arrayOf(scalar("object", "Product cancellation detail row."), "Detail rows."))]
    }),
    endpoint("POST", "/api/products", "Create a new product and return the enriched detail row.", {
      auth: "authenticated",
      requestBody: body(ref("ProductMutationRequest")),
      responses: [response(200, "application/json", ref("ProductCreateResponse"))]
    }),
    endpoint("PUT", "/api/products/:id", "Update a product in place.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      requestBody: body(ref("ProductMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/products/:id", "Soft-delete a product.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/products/:id/restore", "Restore a previously hidden product.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/products/:id/recalculate-profits", "Recalculate all order profits linked to the selected product.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Product identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/products/import-preview", "Parse imported product CSV data without persisting it.", {
      auth: "authenticated",
      requestBody: body(ref("ProductImportPreviewRequest")),
      responses: [response(200, "application/json", ref("ProductImportPreviewResponse"))]
    }),
    endpoint("POST", "/api/products/import-commit", "Persist a previously validated product CSV import batch.", {
      auth: "authenticated",
      requestBody: body(ref("ProductImportCommitRequest")),
      responses: [response(200, "application/json", scalar("object", "Import commit result summary."))]
    }),
    endpoint("GET", "/api/online-products", "Return Ozon online-product rows with local bindings.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("OnlineProductRecord"), "Online-product rows."))]
    }),
    endpoint("POST", "/api/online-products", "Create a local online-product row.", {
      auth: "authenticated",
      requestBody: body(ref("OnlineProductMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("PUT", "/api/online-products/:id", "Update a local online-product row.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Online-product identifier."))],
      requestBody: body(ref("OnlineProductMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/online-products/bind", "Bind an online product to an ERP product and owner.", {
      auth: "authenticated",
      requestBody: body(ref("OnlineProductBindRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/online-products/warehouses", "Return Ozon warehouses for a shop.", {
      auth: "authenticated",
      query: [param("shop_id", scalar("number", "Shop identifier."), true)],
      responses: [response(200, "application/json", ref("OnlineProductWarehousesResponse"))]
    }),
    endpoint("POST", "/api/online-products/batch-stock", "Update Ozon stock for selected online products.", {
      auth: "authenticated",
      requestBody: body(ref("OnlineProductBatchStockRequest")),
      responses: [response(200, "application/json", ref("OnlineProductBatchStockResponse"))]
    }),
    endpoint("POST", "/api/online-products/action", "Record and execute a managed online-product action.", {
      auth: "authenticated",
      requestBody: body(ref("OnlineProductActionRequest")),
      responses: [response(200, "application/json", scalar("object", "Action execution result."))]
    }),
    endpoint("POST", "/api/online-products/create-product", "Create a new ERP product from an online product.", {
      auth: "authenticated",
      requestBody: body(ref("CreateProductFromOnlineProductRequest")),
      responses: [response(200, "application/json", scalar("object", "Created product linkage result."))]
    }),
    endpoint("GET", "/api/mappings", "Return SKU mapping rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("SkuMappingRecord"), "SKU mapping rows."))]
    }),
    endpoint("PUT", "/api/mappings/:id", "Update an existing SKU mapping.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "SKU mapping identifier."))],
      requestBody: body(ref("SkuMappingMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/mappings/:id", "Delete or deactivate an existing SKU mapping.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "SKU mapping identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/image-proxy", "Fetch a remote image through the backend with response validation.", {
      auth: "authenticated",
      query: [param("url", scalar("string", "Absolute HTTP or HTTPS image URL to proxy."))],
      responses: [response(200, "image/*", scalar("binary", "Proxied image payload."))]
    })
  ]),
  section("Inventory", [
    endpoint("GET", "/api/inventory", "Return inventory overview rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("InventorySnapshot"))]
    }),
    endpoint("GET", "/api/stock-alerts", "Return inventory alert rows and replenishment suggestions.", {
      auth: "authenticated",
      responses: [response(200, "application/json", ref("StockAlertsResponse"))]
    }),
    endpoint("GET", "/api/stock-warehouse-rules", "Return stock warehouse classification rules.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("StockWarehouseRule"), "Warehouse classification rules."))]
    }),
    endpoint("POST", "/api/stock-warehouse-rules", "Create a stock warehouse classification rule.", {
      auth: "authenticated",
      requestBody: body(ref("StockWarehouseRuleMutationRequest")),
      responses: [response(200, "application/json", ref("IdResponse"))]
    }),
    endpoint("PUT", "/api/stock-warehouse-rules/:id", "Update a stock warehouse classification rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Warehouse-rule identifier."))],
      requestBody: body(ref("StockWarehouseRuleMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/stock-warehouse-rules/:id", "Disable a stock warehouse classification rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Warehouse-rule identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/erp/inventory-current", "Return the current inventory_current materialized stock rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "inventory_current row."), "Current stock rows."))]
    }),
    endpoint("GET", "/api/erp/raw-orders", "Return raw Ozon order payload rows stored for troubleshooting.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "Raw Ozon order row."), "Raw rows."))]
    }),
    endpoint("GET", "/api/erp/profit-items", "Return raw order_profit_items rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "order_profit_items row."), "Profit item rows."))]
    }),
    endpoint("GET", "/api/erp/order-exceptions", "Return raw order_exceptions rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "order_exceptions row."), "Exception rows."))]
    }),
    endpoint("POST", "/api/inventory/movements", "Create a manual inventory movement row.", {
      auth: "authenticated",
      requestBody: body(ref("InventoryMovementRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/inventory/stock-debts", "Return products whose posted inventory ledger is negative.", {
      auth: "authenticated",
      queryParams: [
        param("search", scalar("string", "Optional product/SKU search text.")),
        param("limit", scalar("number", "Maximum rows to return."))
      ],
      responses: [response(200, "application/json", scalar("object", "Stock-debt rows."))]
    }),
    endpoint("POST", "/api/inventory/stock-debts/adjust", "Create a positive manual adjustment to clear historical negative stock debt.", {
      auth: "authenticated",
      requestBody: body(scalar("object", "Stock-debt adjustment request.")),
      responses: [response(200, "application/json", scalar("object", "Adjustment result."))]
    }),
    endpoint("GET", "/api/inbound-records", "Return inbound record rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("InboundRecord"), "Inbound rows."))]
    }),
    endpoint("POST", "/api/inbound-records", "Create an inbound record.", {
      auth: "authenticated",
      requestBody: body(ref("InboundRecordMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("PUT", "/api/inbound-records/:id", "Update an inbound record.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Inbound-record identifier."))],
      requestBody: body(ref("InboundRecordMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/inbound-records/:id", "Delete an inbound record.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Inbound-record identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/outbound-records", "Return outbound stock deduction rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("OutboundRecord"), "Outbound rows."))]
    })
  ]),
  section("Procurement", [
    endpoint("GET", "/api/procurement/summary", "Return procurement summary counters.", {
      auth: "authenticated",
      responses: [response(200, "application/json", scalar("object", "Procurement summary payload."))]
    }),
    endpoint("GET", "/api/procurement/requests", "Return procurement request rows.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ProcurementRequestRecord"), "Procurement request rows."))]
    }),
    endpoint("POST", "/api/procurement/requests", "Create a procurement request.", {
      auth: "authenticated",
      requestBody: body(ref("ProcurementRequestMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("PUT", "/api/procurement/requests/:id", "Update a procurement request.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Procurement-request identifier."))],
      requestBody: body(ref("ProcurementRequestMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/procurement/requests/submit", "Bulk-submit procurement requests for approval or purchase merging.", {
      auth: "authenticated",
      requestBody: body(ref("ProcurementSubmitRequest")),
      responses: [response(200, "application/json", scalar("object", "Submit result summary."))]
    }),
    endpoint("DELETE", "/api/procurement/requests/:id", "Delete a procurement request.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Procurement-request identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/procurement/purchase-orders", "Return purchase-order headers.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("PurchaseOrderRecord"), "Purchase-order rows."))]
    }),
    endpoint("POST", "/api/procurement/purchase-orders", "Merge selected procurement requests into a purchase order.", {
      auth: "authenticated",
      requestBody: body(ref("MergePurchaseOrdersRequest")),
      responses: [response(200, "application/json", scalar("object", "Created purchase-order result."))]
    }),
    endpoint("GET", "/api/procurement/purchase-orders/:id", "Return one purchase order with merged line items.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Purchase-order identifier."))],
      responses: [response(200, "application/json", scalar("object", "Purchase-order detail payload.")), response(404, "application/json", ref("ErrorResponse"))]
    }),
    endpoint("PUT", "/api/procurement/purchase-orders/:id", "Update a purchase order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Purchase-order identifier."))],
      requestBody: body(ref("PurchaseOrderMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/procurement/purchase-orders/:id", "Delete a purchase order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Purchase-order identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/procurement/purchase-orders/:id/confirm-purchased", "Confirm that a purchase order has been purchased.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Purchase-order identifier."))],
      requestBody: body(ref("PurchaseOrderConfirmRequest"), false),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/procurement/purchase-orders/:id/cancel", "Cancel a purchase order.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Purchase-order identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/procurement/pending-inbound", "Return procurement items that are still waiting for inbound completion.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(scalar("object", "Pending inbound row."), "Pending inbound rows."))]
    })
  ]),
  section("Configuration", [
    endpoint("GET", "/api/shops", "Return shop master data.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("ShopRecord"), "Shop rows."))]
    }),
    endpoint("POST", "/api/shops", "Create a shop.", {
      auth: "authenticated",
      requestBody: body(ref("ShopMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("PUT", "/api/shops/:id", "Update a shop.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Shop identifier."))],
      requestBody: body(ref("ShopMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/shops/:id", "Delete or deactivate a shop.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Shop identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/people", "Return person master data.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("PersonRecord"), "Person rows."))]
    }),
    endpoint("POST", "/api/people", "Create a person.", {
      auth: "authenticated",
      requestBody: body(ref("PersonMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("PUT", "/api/people/:id", "Update a person.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Person identifier."))],
      requestBody: body(ref("PersonMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/people/:id", "Soft-delete a person, or hard-delete when hard=1 is set.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Person identifier."))],
      query: [param("hard", scalar("boolean", "When true, attempt hard deletion."), false)],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/suppliers", "Return supplier master data.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("SupplierRecord"), "Supplier rows."))]
    }),
    endpoint("POST", "/api/suppliers", "Create a supplier.", {
      auth: "authenticated",
      requestBody: body(ref("SupplierMutationRequest")),
      responses: [response(200, "application/json", ref("IdResponse"))]
    }),
    endpoint("PUT", "/api/suppliers/:id", "Update a supplier.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Supplier identifier."))],
      requestBody: body(ref("SupplierMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/suppliers/:id", "Deactivate a supplier after link validation.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Supplier identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/logistics-rules", "Return logistics fee rules.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("LogisticsRule"), "Logistics-rule rows."))]
    }),
    endpoint("POST", "/api/logistics-rules", "Create a logistics fee rule.", {
      auth: "authenticated",
      requestBody: body(ref("LogisticsRuleMutationRequest")),
      responses: [response(200, "application/json", ref("IdResponse"))]
    }),
    endpoint("PUT", "/api/logistics-rules/:id", "Update a logistics fee rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Logistics-rule identifier."))],
      requestBody: body(ref("LogisticsRuleMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/logistics-rules/:id", "Disable a logistics fee rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Logistics-rule identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("GET", "/api/order-cancellation-rules", "Return cancellation and return classification rules.", {
      auth: "authenticated",
      responses: [response(200, "application/json", arrayOf(ref("OrderCancellationRule"), "Cancellation-rule rows."))]
    }),
    endpoint("POST", "/api/order-cancellation-rules", "Create a cancellation classification rule.", {
      auth: "authenticated",
      requestBody: body(ref("OrderCancellationRuleMutationRequest")),
      responses: [response(200, "application/json", ref("IdResponse"))]
    }),
    endpoint("PUT", "/api/order-cancellation-rules/:id", "Update a cancellation classification rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Cancellation-rule identifier."))],
      requestBody: body(ref("OrderCancellationRuleMutationRequest")),
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("DELETE", "/api/order-cancellation-rules/:id", "Disable a cancellation classification rule.", {
      auth: "authenticated",
      pathParams: [param("id", scalar("number", "Cancellation-rule identifier."))],
      responses: [response(200, "application/json", ref("MutationOk"))]
    }),
    endpoint("POST", "/api/order-cancellation-rules/test", "Evaluate one cancellation rule against sample text.", {
      auth: "authenticated",
      requestBody: body(ref("OrderCancellationRuleTestRequest")),
      responses: [response(200, "application/json", scalar("object", "Rule-test result payload."))]
    }),
    endpoint("POST", "/api/pricing/cel-fbs", "Run the CEL FBS pricing calculator for a single input payload.", {
      auth: "authenticated",
      requestBody: body(ref("CelFbsPricingRequest")),
      responses: [response(200, "application/json", scalar("object", "Pricing calculation result."))]
    })
  ]),
  section("Synchronization", [
    endpoint("POST", "/api/sync/ozon", "Run a full Ozon order synchronization for a requested date window.", {
      auth: "authenticated",
      requestBody: body(ref("DateRangeSyncRequest"), false),
      responses: [response(200, "application/json", scalar("object", "Order sync result summary."))]
    }),
    endpoint("POST", "/api/sync/ozon/incremental", "Run an incremental Ozon order synchronization.", {
      auth: "authenticated",
      requestBody: body(ref("DateRangeSyncRequest"), false),
      responses: [response(200, "application/json", scalar("object", "Incremental sync result summary."))]
    }),
    endpoint("POST", "/api/sync/online-products", "Synchronize online-product snapshots from Ozon.", {
      auth: "authenticated",
      requestBody: body(objectOf("Online-product sync payload.", [
        field("shop_id", scalar("number", "Optional target shop identifier.")),
        field("online_product_ids", arrayOf(scalar("number", "Online-product identifier."), "Optional selected online-product identifiers."))
      ], { additionalProperties: false }), false),
      responses: [response(200, "application/json", scalar("object", "Online-product sync result summary."))]
    }),
    endpoint("POST", "/api/sync/ozon-stocks", "Synchronize Ozon stock snapshots and classifications.", {
      auth: "authenticated",
      requestBody: body(objectOf("Ozon stock sync payload.", [
        field("shop_id", scalar("number", "Optional target shop identifier.")),
        field("force", scalar("boolean", "Whether to bypass light guards."))
      ], { additionalProperties: false }), false),
      responses: [response(200, "application/json", scalar("object", "Stock sync result summary."))]
    }),
    endpoint("POST", "/api/sync/ozon-finance", "Synchronize Ozon finance transactions and derived profit data.", {
      auth: "authenticated",
      requestBody: body(ref("DateRangeSyncRequest"), false),
      responses: [response(200, "application/json", scalar("object", "Finance sync result summary."))]
    })
  ])
];

export function createApiDocumentation() {
  return {
    generatedAt: new Date().toISOString(),
    title: "Ozon ERP Backend API Reference",
    overview: [
      "All endpoints live in the native Node.js HTTP server and return JSON unless the media type says otherwise.",
      "Authenticated endpoints require an Authorization header with a Bearer token from /api/auth/login.",
      "Every endpoint contract is maintained in src/server/api-docs.js as the single source of truth.",
      "Unexpected failures return the standard ErrorResponse payload with HTTP status 4xx or 5xx."
    ],
    changePolicy,
    schemas,
    sections: endpoints
  };
}

export function renderApiDocumentationMarkdown(catalog = createApiDocumentation()) {
  const lines = [];
  lines.push("# Ozon ERP Backend API Reference");
  lines.push("");
  lines.push(`Generated from code metadata at \`${catalog.generatedAt}\`.`);
  lines.push("");
  lines.push("## Conventions");
  lines.push("");
  for (const item of catalog.overview) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## T0 API Change Policy");
  lines.push("");
  lines.push(`Tier: \`${catalog.changePolicy.tier}\``);
  lines.push("");
  lines.push("Mandatory rules:");
  for (const rule of catalog.changePolicy.requirements) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Enforcement:");
  for (const step of catalog.changePolicy.enforcement) lines.push(`- ${step}`);
  lines.push("");
  lines.push("## Schemas");
  lines.push("");
  for (const [name, schema] of Object.entries(catalog.schemas)) {
    lines.push(`### ${name}`);
    lines.push("");
    renderSchemaMarkdown(lines, schema);
    lines.push("");
  }
  lines.push("## Endpoints");
  lines.push("");
  for (const section of catalog.sections) {
    lines.push(`### ${section.name}`);
    lines.push("");
    for (const item of section.endpoints) {
      lines.push(`#### \`${item.method} ${item.path}\``);
      lines.push("");
      lines.push(item.description);
      lines.push("");
      lines.push(`- Auth: \`${item.auth}\``);
      if (item.pathParams?.length) {
        lines.push("- Path parameters:");
        for (const value of item.pathParams) lines.push(`  - ${renderFieldLine(value)}`);
      }
      if (item.query?.length) {
        lines.push("- Query parameters:");
        for (const value of item.query) lines.push(`  - ${renderFieldLine(value)}`);
      }
      if (item.requestBody) {
        lines.push(`- Request body: ${item.requestBody.required ? "required" : "optional"}`);
        if (item.requestBody.description) lines.push(`  - ${item.requestBody.description}`);
        lines.push(`  - Schema: \`${schemaLabel(item.requestBody.schema)}\``);
      }
      if (item.responses?.length) {
        lines.push("- Responses:");
        for (const result of item.responses) {
          lines.push(`  - \`${result.status}\` \`${result.mediaType}\` -> \`${schemaLabel(result.schema)}\`${result.description ? `: ${result.description}` : ""}`);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderSchemaMarkdown(lines, schema) {
  lines.push(schema.description || "No description.");
  if (schema.additionalProperties === false) {
    lines.push("");
    lines.push("`additionalProperties: false`");
  }
  if (!schema.fields?.length) {
    lines.push("");
    lines.push(`Type: \`${schemaLabel(schema)}\``);
    return;
  }
  lines.push("");
  lines.push("| Field | Type | Required | Description |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of schema.fields) {
    lines.push(`| \`${item.name}\` | \`${schemaLabel(item)}\` | ${item.required ? "Yes" : "No"} | ${item.description || ""} |`);
  }
}

function renderFieldLine(item) {
  return `\`${item.name}\` (\`${schemaLabel(item)}\`, ${item.required ? "required" : "optional"}): ${item.description || ""}`;
}

function schemaLabel(schema) {
  if (!schema) return "unknown";
  if (schema.ref) return schema.ref;
  if (schema.kind === "array") return `array<${schemaLabel(schema.items)}>`;
  if (schema.kind === "object") return "object";
  return schema.type || schema.kind || "unknown";
}

function section(name, items) {
  return { name, endpoints: items };
}

function endpoint(method, path, description, extra = {}) {
  return {
    method,
    path,
    description,
    auth: extra.auth || "authenticated",
    pathParams: extra.pathParams || [],
    query: extra.query || [],
    requestBody: extra.requestBody || null,
    responses: extra.responses || [response(200, "application/json", ref("MutationOk"))]
  };
}

function queryFieldsFromSchema(schemaName, include = null) {
  const source = schemas[schemaName];
  if (!source?.fields?.length) return [];
  return source.fields
    .filter((item) => !include || include.includes(item.name))
    .map((item) => param(item.name, fieldToSchema(item), false));
}

function fieldToSchema(item) {
  if (item.ref) return ref(item.ref, item.description);
  if (item.kind === "array") return arrayOf(item.items, item.description);
  if (item.kind === "object") return objectOf(item.description, item.fields || []);
  return scalar(item.type, item.description, pickScalarMeta(item));
}

function pickScalarMeta(item) {
  const extra = {};
  if (item.enum) extra.enum = item.enum;
  if (item.format) extra.format = item.format;
  return extra;
}
