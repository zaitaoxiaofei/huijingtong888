import assert from "node:assert/strict";
import test from "node:test";
import { handleOrderRestRoute } from "../src/server/routes/orders.js";

function routeArgs(path, serviceName, service) {
  const responses = [];
  return {
    responses,
    args: {
      req: { method: "POST", _session: { personId: 7, tenant: { id: 1, slug: "default" } } },
      res: {},
      url: new URL(`http://localhost${path}`),
      parts: path.split("/").filter(Boolean),
      services: { [serviceName]: service },
      readJson: async () => ({ order_ids: [23], print_batch_id: "batch-1" }),
      json: (_res, payload) => { responses.push(payload); return payload; },
      notFound: () => null,
      writeHead: () => {}
    }
  };
}

for (const [path, serviceName] of [
  ["/api/orders/package-label-printed", "markOrderLabelsPrinted"],
  ["/api/orders/package-label-print-failed", "removeFailedOrderLabelPrintBatch"]
]) {
  test(`${path} waits for the database result before responding`, async () => {
    let resolveSave;
    const pendingSave = new Promise((resolve) => { resolveSave = resolve; });
    const { args, responses } = routeArgs(path, serviceName, () => pendingSave);
    const request = handleOrderRestRoute(args);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(responses, []);
    const saved = { ok: true, count: 1, print_batch_id: "batch-1" };
    resolveSave(saved);
    assert.deepEqual(await request, saved);
    assert.deepEqual(responses, [saved]);
  });

  test(`${path} does not report success when saving fails`, async () => {
    const { args, responses } = routeArgs(path, serviceName, async () => { throw new Error("DB unavailable"); });
    await assert.rejects(handleOrderRestRoute(args), /DB unavailable/);
    assert.deepEqual(responses, []);
  });
}
