export async function fetchOzonPackageLabelTask(postings, { request, download, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), signal }) {
  const check = () => { if (signal?.aborted) throw signal.reason || new Error('面单下载已取消'); };
  check();
  const created = await request('/v3/posting/fbs/package-label/create', { posting_numbers: postings });
  const tasks = created.tasks || created.result?.tasks || [];
  const task = tasks.find(item => item.task_type === 'small_label') || tasks.find(item => item.task_type === 'big_label');
  if (!task?.task_id) throw new Error('Ozon 未返回可用的面单生成任务，请稍后重试');
  for (let poll = 0; poll < 30; poll++) {
    check();
    const response = await request('/v2/posting/fbs/package-label/get', { task_id: task.task_id });
    const result = response.result || response;
    const status = typeof result.status === 'object' ? result.status?.code : result.status;
    if (result.error || status === 'failed' || status === 'error') throw new Error(`Ozon 面单生成失败：${typeof result.error === 'string' ? result.error : JSON.stringify(result.error || status)}`);
    if (status === 'completed') {
      if (result.status?.unprinted_postings?.length || (result.status?.printed_postings_count != null && Number(result.status.printed_postings_count) !== postings.length)) throw new Error('Ozon 未生成全部订单的面单，本次未打印，请核查订单后重试');
      if (!result.file_url) throw new Error('Ozon 面单任务已完成，但未返回 PDF 文件');
      check();
      const buffer = await download(result.file_url);
      if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Ozon 返回的面单文件不是有效 PDF，请重试');
      return buffer;
    }
    if (poll < 29) await wait(1000);
  }
  throw new Error('Ozon 面单仍在生成，请稍后重试；本次未进入打印');
}
