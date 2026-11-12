export const pendingPerformanceReport = (state = {}) => Object.assign(new Error(state.uuid
  ? 'Ozon 广告报表尚未完成，已保存任务编号，下次同步继续查询原报表。'
  : 'Ozon 广告报表创建结果待确认，已阻止重复创建；请检查任务日志后再处理。'), {
  code: 'OZON_AD_REPORT_PENDING', reportUuid: state.uuid || null
});

// Status-only responses must never settle an empty financial report.
export function hasPerformanceReportRows(data) {
  if (!data || typeof data !== 'object') return false;
  return [data, data.rows, data.items, data.data, data.result?.rows, data.result?.items, data.result?.data].some(Array.isArray)
    || Object.values(data).some(value => Array.isArray(value?.report?.rows));
}

export async function fetchDurablePerformanceReport(payload, { checkpoints, request, wait, ready, activeLimit, rateLimit, log, completed, signal,
  retryDelayMs, initialDelayMs, pollDelayMs, missingDelayMs, pollAttempts }) {
  if (!checkpoints || !Array.isArray(completed)) throw new Error('广告报表恢复存储未初始化');
  for (const endpoint of ['/api/client/statistics/json', '/api/client/statistics/products/json']) {
    signal?.throwIfAborted();
    const handle = await checkpoints.claim(payload, endpoint);
    let uuid = handle.uuid;
    if (!uuid) {
      let creationError;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const receipt = await request(endpoint, payload);
          uuid = receipt.UUID || receipt.uuid || receipt.report_id || receipt.result?.UUID || receipt.result?.uuid;
          if (!uuid) {
            await checkpoints.unknown(handle);
            throw pendingPerformanceReport();
          }
          uuid = String(uuid);
          await checkpoints.save(handle, uuid);
          break;
        } catch (error) {
          if (error.code === 'OZON_AD_REPORT_PENDING') throw error;
          if (activeLimit(error) && attempt < 5) {
            try { await wait(Math.max(retryDelayMs + attempt * 5000, Number(error.retryAfterMs) || 0), signal); }
            catch (cancelled) { await checkpoints.rejected(handle);throw cancelled; }
            continue;
          }
          // A missing receipt after a network/server error is not proof of rejection.
          // Keep the claim across restarts instead of creating another report.
          if (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 && Number(error.statusCode) !== 408) {
            await checkpoints.rejected(handle);
            creationError = error;
            break;
          }
          await checkpoints.unknown(handle);
          throw pendingPerformanceReport();
        }
      }
      if (creationError) {
        if ([404, 405].includes(Number(creationError.statusCode)) && endpoint.endsWith('/statistics/json')) continue;
        throw creationError;
      }
    }
    handle.uuid = uuid;
    try {
      await log({ stepKey: 'report_uuid', status: 'info', message: `${handle.resumed ? 'Resuming' : 'Created'} performance report ${uuid}`, detail: { uuid, resumed: handle.resumed, from: payload.dateFrom, to: payload.dateTo } });
      if (!handle.resumed) await wait(initialDelayMs, signal);
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        let missing = false;
        for (const path of [`/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`, `/api/client/statistics/${encodeURIComponent(uuid)}`]) {
          try {
            const data = await request(path, null, 'GET');
            if (ready(data) && hasPerformanceReportRows(data)) {
              completed.push(handle);
              return data;
            }
          } catch (error) {
            if ([401, 403].includes(Number(error.statusCode))) throw error;
            if (rateLimit(error)) {
              error.reportUuid = uuid;
              error.retryAfterMs = Math.max(60000, Number(error.retryAfterMs) || 0);
              throw error;
            }
            missing = Number(error.statusCode) === 404;
          }
        }
        await wait(missing ? missingDelayMs : pollDelayMs, signal);
      }
      throw pendingPerformanceReport({ uuid });
    } catch (error) {
      error.reportUuid = uuid;
      await checkpoints.defer(handle, error.retryAfterMs);
      throw error;
    }
  }
  throw new Error('Ozon 广告报表接口不可用');
}
