# FBS first and formal FBP demand

Requested priority: FBS orders, formal FBP applications, local safety, forecast FBP demand. Physical stock 17, FBS 4, approved/unshipped FBP 15 now covers FBS 4 and FBP 13; mandatory shortage 2 belongs to FBP, optional safety remains 9.

Formal FBP demand includes pending review and approved/unshipped quantities. Approved quantities and actual transfer transit are separate facts. Sent transfers leave local demand and show in transit; approval alone never means transport. Existing pending-only fields remain compatible. Snapshot version changes to demand-v10-fbs-first.

New outbound dispatch checks fresh physical quantities and live FBS demand under physical-product locks. Bundle outbound consumes free assembled units first and posts only the loose remainder against actual components; virtual parent history is never treated as assembled stock; shared-child concurrent shipments cannot consume the same stock. Existing shipped records are not rewritten. Original request and effective approved/adjusted quantities remain separately inspectable.

Validation: 82 focused unit tests; 54 isolated MySQL tests covering workflow reads, source quantities, blocked/valid/idempotent shipment, tenant isolation, shared-child concurrency, receipt records and workspace performance; frontend production build; SQL bindings, encoding and generated API docs checks. Ego browser verified the actual demand-line component for the 17/4/15 case, sent10/pending5 case, and mixed pending/approved quantities.

Two unrelated baseline failures were reproduced on untouched 742a909e: fbp-four-demand-policy covered procurement advisory total, and fbp-replenishment-sku-binding missing VM invalidation mock. They are not changed by this release.

Deployment is pending concrete ECS rollout approval per AGENTS.md. No production data repair is required.

Concurrent release d808ece2 added explicit bundle assembly/disassembly. This task merged it, preserved finished-unit movements and made finished FBS allocation outrank approved FBP reservations. Mixed finished/loose FBP shipment is covered by MySQL validation.
