import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardTrendRows, dashboardTrendGeometry } from '../frontend/admin/utils/dashboard-trend.js';

test('trend aligns actual calendar days across a year boundary and preserves missing days as gaps', () => {
 const rows = dashboardTrendRows([{ date_key: '2025-12-31', revenue: 100, profit: 10 }, { date_key: '2026-01-02', revenue: 0, profit: -5 }, { date_key: '2026-01-03', revenue: 50, profit: 4 }], '2026-01-03', 7);
 assert.equal(rows[0].date_key, '2025-12-28');
 assert.equal(rows[4].date_key, '2026-01-01');
 assert.equal(rows[4].revenue, undefined);
 const chart = dashboardTrendGeometry(rows, true);
 assert.equal(chart.min, -5);
 assert.equal(chart.max, 100);
 assert.equal((chart.paths.revenue.match(/M/g) || []).length, 2, 'do not draw a fabricated line across a missing snapshot');
 assert.equal((chart.paths.revenue.match(/L/g) || []).length, 1);
 assert.ok(!chart.paths.profit.includes('NaN'));
});
test('staff trend never includes profit in its geometry or scale', () => {
 const rows = [{ date_key: '2026-11-12', revenue: 100, profit: 50000 }];
 const chart = dashboardTrendGeometry(rows, false);
 assert.equal(chart.max, 100);
 assert.equal(chart.paths.profit, undefined);
 assert.equal(dashboardTrendGeometry([{ revenue: null }]).hasData, false);
 assert.equal(dashboardTrendGeometry([{ revenue: 0 }]).hasData, true);
 assert.deepEqual(dashboardTrendRows([], 'bad-date'), []);
});
