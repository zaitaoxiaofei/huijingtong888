// SQL BIGINT and JSON decimal strings keep balances exact above 2^53.
export const MAX_AI_CREDIT_POINTS = 9223372036854775807n;
export const DEFAULT_AI_CREDIT_POINTS = 10000000000000000n;
export const MONTHLY_AI_CREDIT_POINTS = 100n;
export function aiCreditPoints(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)
    || !["string", "number", "bigint"].includes(typeof value) || !/^-?\d+$/.test(String(value))) {
    throw Object.assign(new Error("积分必须为精确整数；大额积分请使用十进制字符串"), { status: 400, statusCode: 400, code: "AI_CREDIT_INVALID" });
  }
  const points = BigInt(value);
  if (points < -MAX_AI_CREDIT_POINTS || points > MAX_AI_CREDIT_POINTS) throw Object.assign(new Error("积分超出账本范围"), { status: 400, statusCode: 400, code: "AI_CREDIT_INVALID" });
  return points;
}
export function aiCreditPointsValue(value) {
  const points = aiCreditPoints(value);
  return points >= BigInt(Number.MIN_SAFE_INTEGER) && points <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(points) : String(points);
}
export function aiCreditPointsText(value = 0) { return aiCreditPoints(value).toLocaleString("zh-CN"); }
export function aiCreditYuanText(value = 0) {
  const points = aiCreditPoints(value), absolute = points < 0n ? -points : points;
  return `${points < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
