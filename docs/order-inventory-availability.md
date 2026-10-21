# Order-list inventory facts

`GET /api/orders/inventory-availability?orderIds=1,2` supplements the current order page without delaying its initial rows for procurement reconciliation. `orderIds` (or `order_ids`) accepts 1–100 comma-separated positive integer IDs. Duplicate IDs are removed; response order follows the request. `refresh=1` forces the existing product-balance loader to refresh after an inventory change.

```json
{
  "rows": [
    {
      "order_id": 1,
      "inventory_availability": [
        {
          "product_id": 8,
          "physical_stock": 11,
          "available_stock": 5,
          "inventory_needs_review": false
        }
      ]
    }
  ]
}
```

The service first authorizes every requested order using its shop. A missing or unauthorized order rejects the whole batch with 404. Ordinary tenants require the shop's exact tenant and active status. Administrator batches derive each order's actual tenant from its shop and load separate tenant balances. Only the default tenant can include legacy null ownership. Client-supplied tenant or product IDs cannot widen the batch.

Current mapping, combo recipe and component records determine the physical product IDs; unbound orders return an empty fact array. The service does not load full enriched order rows or calculate procurement coverage. Facts do not contain this-order stock allocations, incoming allocations or purchase shortages and must not be merged into fabricated `procurement_coverage` records.

The existing `mysql-inventory-product-balance.js` owns arithmetic and caching: physical stock adds back unshipped orders' net posted outbound deductions to the local ledger; available stock subtracts all local unshipped demand and FBP reservations, clamped at zero. All demand for these products within the tenant is included, rather than only the current page. FBP orders do not consume local demand or local deduction add-backs. Negative physical stock and its review flag remain intact. Missing or nonnumeric balance facts reject with 503 and never become zero stock.

This API reuses the balance loader's 45-second fresh and 90-second maximum stale snapshot behavior. It may refresh the derived `inventory_product_balance` cache; it does not write movements, allocations, purchases or profit results. Procurement coverage and the balance loader share normal physical/available arithmetic, but the existing balance path additionally uses the shared transport-history evidence and nets `order_outbound_adjustment` movements. This change does not modify either calculation implementation.

The runtime is MySQL. An unavailable service adapter returns an explicit 503 instead of pretending that another backend supplied inventory facts.
