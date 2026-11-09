// Each generated image owns a durable wallet task and recovery receipt. Failed
// slots never turn a successful sibling into a refund or a second submission.
export async function runAiCreditImageBatch(count, generate) {
  const results = [], failures = [];
  for (let index = 0; index < count; index += 1) {
    try { results.push(await generate(index)); }
    catch (error) {
      if (error.code !== "AI_CREDIT_TASK_FAILED") throw error;
      failures.push({ index, code: error.code, message: error.message });
    }
  }
  if (!results.length) throw Object.assign(new Error("图片生成均已失败，积分已返还"), { code: "AI_CREDIT_TASK_FAILED", status: 502, statusCode: 502 });
  return { results, failures };
}
