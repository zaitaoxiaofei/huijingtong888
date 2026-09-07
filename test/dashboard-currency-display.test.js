import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");

test("dashboard labels RMB amounts explicitly instead of using the ambiguous yen symbol", () => {
  const formatterStart = dashboardSource.indexOf("function metricMoney");
  const formatterEnd = dashboardSource.indexOf("function metricNumber", formatterStart);
  const formatter = dashboardSource.slice(formatterStart, formatterEnd);

  assert.match(formatter, /`CNY \$\{moneyText\(value\)\}`/);
  assert.doesNotMatch(formatter, /¥/);
});
