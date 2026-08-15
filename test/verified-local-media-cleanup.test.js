import assert from "node:assert/strict";
import test from "node:test";
import { candidateObjectKeys, parseCleanupArgs } from "../scripts/cleanup-verified-local-media.mjs";

test("verified local media cleanup is dry-run with seven-day retention by default", () => {
  assert.deepEqual(parseCleanupArgs([]), { write: false, retentionDays: 7, limit: 200 });
});

test("verified local media cleanup accepts bounded write options", () => {
  assert.deepEqual(parseCleanupArgs(["--write", "--days", "14", "--limit", "50"]), {
    write: true,
    retentionDays: 14,
    limit: 50
  });
});

test("content-addressed cleanup checks only approved OSS prefixes", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(candidateObjectKeys(hash, ".png", ["ai-unused", "listing-media"]), [
    `ai-unused/aa/${hash}.png`,
    `listing-media/aa/${hash}.png`
  ]);
});
