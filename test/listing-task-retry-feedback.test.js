import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/admin/views/listing/ListingPublishRecordsView.vue', import.meta.url), 'utf8');
const retrySource = source.slice(source.indexOf('async function retryPublishTask('), source.indexOf('async function mapFrontendConcurrency('));

function retryContext(get) {
  const messages = [];
  const context = vm.createContext({
    taskRetryingId: { value: null }, taskDrawer: { task: null, visible: false },
    taskRetryFeedback: {}, taskCanRetry: () => true,
    apiClient: { get }, batchListing: {},
    ElMessage: { error: (message) => messages.push(message), warning: (message) => messages.push(message) }
  });
  vm.runInContext(retrySource, context);
  return { context, messages };
}

test('retry request errors remain visible and release the retry lock', async () => {
  const { context, messages } = retryContext(async () => { throw new Error('图片下载失败'); });
  await context.retryPublishTask({ id: 12 });
  assert.equal(context.taskRetryFeedback.type, 'error');
  assert.match(context.taskRetryFeedback.message, /图片下载失败/);
  assert.equal(messages.length, 1);
  assert.equal(context.taskRetryingId.value, null);
  assert.equal(context.batchListing.browserPreparing, false);
});

test('pending retry gives immediate feedback and prevents duplicate submission', async () => {
  let resolve;
  let requests = 0;
  const { context } = retryContext(() => { requests++; return new Promise((done) => { resolve = done; }); });
  const pending = context.retryPublishTask({ id: 12 });
  assert.match(context.taskRetryFeedback.message, /正在加载/);
  await context.retryPublishTask({ id: 12 });
  assert.equal(requests, 1);
  resolve({ items: [] });
  await pending;
  assert.equal(context.taskRetryFeedback.type, 'warning');
  assert.equal(context.taskRetryingId.value, null);
});

test('task polling reports failures and recovers on the next refresh', async () => {
  let fail = true;
  const context = vm.createContext({
    isPublishMode: { value: true }, isTaskMode: { value: true }, taskRefreshRunning: false,
    taskDrawer: { visible: false }, taskRefreshError: { value: '' },
    loadPublishTasks: async () => { if (fail) throw new Error('连接中断'); }
  });
  vm.runInContext(source.slice(source.indexOf('async function refreshTaskProgress('), source.indexOf('const taskDrawer = reactive(')), context);
  await context.refreshTaskProgress();
  assert.match(context.taskRefreshError.value, /连接中断/);
  fail = false;
  await context.refreshTaskProgress();
  assert.equal(context.taskRefreshError.value, '');
  assert.equal(context.taskRefreshRunning, false);
});


test('record retry displays the returned failure rather than a success toast', () => {
  const messages = [];
  const context = vm.createContext({
    recordRetryFeedback: {}, publishFailureReason: row => row.error_summary,
    publishFailureFixTip: row => row.error_fix_tip || '',
    ElMessage: { error: message => messages.push(['error', message]), success: message => messages.push(['success', message]) }
  });
  vm.runInContext(source.slice(source.indexOf('function showRecordRetryResult('), source.indexOf('async function retryFailedRecord(')), context);
  context.showRecordRetryResult({ status: 'failed', error_summary: '今日额度不足', error_fix_tip: '请检查店铺额度' });
  assert.equal(context.recordRetryFeedback.type, 'error');
  assert.match(context.recordRetryFeedback.message, /今日额度不足/);
  assert.equal(messages[0][0], 'error');
  context.showRecordRetryResult({ status: 'imported' });
  assert.equal(context.recordRetryFeedback.type, 'success');
  assert.doesNotMatch(context.recordRetryFeedback.message, /额度不足/);
});
