import assert from "node:assert/strict";
import test from "node:test";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";

test("successful AI outcomes require an explicit positive verified result count before accessing money storage", async () => {
  let transactions = 0;
  const ledger = createAiCreditLedger({ transaction: async () => { transactions += 1; throw new Error("Validation must reject before SQL"); } });
  const outcome = { attemptId: "12345678-1234-1234-1234-123456789012", outcome: "succeeded", outcomeSha256: "a".repeat(64),
    resultReference: "private:verified-result", resultSha256: "b".repeat(64) };
  for (const count of [undefined, null, 0, -1, 1.5, "1.5", 101]) {
    await assert.rejects(ledger.recordOutcome({ personId: 7, tenant: { id: 2 } }, "12345678-1234-1234-1234-123456789013", { ...outcome, successfulResults: count }),
      { code: "AI_CREDIT_INVALID", status: 400 });
  }
  assert.equal(transactions, 0, "missing actual results must not silently charge the full reserved count");
});
