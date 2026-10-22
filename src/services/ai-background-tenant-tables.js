// Shared by the explicit migration and startup readiness checks.
export const AI_BACKGROUND_TENANT_TABLES = [
  ["ai_variant_lab_analyses", "uniq_ai_variant_lab_analyses_no", "analysis_no"],
  ["ai_variant_lab_plans", "uniq_ai_variant_lab_plans_no", "plan_no"],
  ["ai_variant_templates", "uniq_ai_variant_templates_key", "template_key"],
  ["ai_variant_template_cases", "uniq_ai_variant_template_cases_key", "case_key"],
  ["ai_variant_case_templates", "uniq_ai_variant_case_templates_no", "case_no"],
  ["ai_variant_case_runs", "uniq_ai_variant_case_runs_no", "run_no"],
  ["ai_variant_lab_batch_jobs", "uniq_ai_variant_lab_batch_jobs_no", "job_no"],
  ["ai_variant_lab_batch_items", "uniq_ai_variant_lab_batch_items_no", "item_no"],
  ["ai_image_usage_events", "uniq_ai_image_usage_request", "request_key"],
  ["ai_image_optimizer_jobs", "uniq_ai_image_optimizer_jobs_no", "job_no"],
  ["ai_generation_tasks", "uq_ai_generation_task_no", "task_no"],
  ["ai_variant_draft_save_batches"], ["ai_variant_draft_save_items"], ["asset_variant_jobs"], ["listing_ozon_copy_jobs"]
];
