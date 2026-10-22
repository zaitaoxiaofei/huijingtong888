export const ACCOUNT_KIND_AUDIT_SQL = `CREATE TABLE IF NOT EXISTS people_account_kind_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  person_id BIGINT UNSIGNED NOT NULL,
  previous_kind VARCHAR(16) NOT NULL,
  account_kind VARCHAR(16) NOT NULL,
  reviewed_by_person_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  reviewed_at DATETIME(3) NOT NULL,
  KEY idx_account_kind_person (person_id, reviewed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export function normalizeAccountKindReview(value) {
  const positiveId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;
  if (value?.version !== 1 || !positiveId(value.reviewed_by_person_id) || !String(value.reason || "").trim()
    || String(value.reason).trim().length > 500 || !Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > 200) {
    throw new Error("Review requires version 1, a reviewer person ID, a reason and 1-200 explicit accounts");
  }
  const ids = new Set();
  const accounts = value.accounts.map(account => {
    if (!positiveId(account.person_id) || ids.has(Number(account.person_id))
      || !["person", "system"].includes(account.account_kind) || !["person", "system"].includes(account.expected_account_kind)) {
      throw new Error("Every account requires a unique positive person_id, expected_account_kind and account_kind (person or system)");
    }
    ids.add(Number(account.person_id));
    return { person_id: Number(account.person_id), expected_account_kind: account.expected_account_kind, account_kind: account.account_kind };
  });
  return { version: 1, reviewed_by_person_id: Number(value.reviewed_by_person_id), reason: String(value.reason).trim(), accounts: accounts.sort((a, b) => a.person_id - b.person_id) };
}

// Caller owns the transaction. No names, legacy roles or memberships infer kind.
export async function applyAccountKindReview(connection, manifest) {
  const review = normalizeAccountKindReview(manifest);
  // Classification uses the same ordered person locks as private-message writes.
  const people = new Map();
  const ids = [...new Set([review.reviewed_by_person_id, ...review.accounts.map(account => account.person_id)])].sort((a, b) => a - b);
  for (const personId of ids) {
    const [rows] = await connection.execute("SELECT id, account_kind, active FROM people WHERE id = ? FOR UPDATE", [personId]);
    if (rows.length) people.set(personId, rows[0]);
  }
  const [reviewers] = await connection.execute(`SELECT person_id FROM platform_grants
    WHERE person_id = ? AND role = 'super_admin' AND active = 1 FOR SHARE`, [review.reviewed_by_person_id]);
  if (!reviewers.length || Number(people.get(review.reviewed_by_person_id)?.active) !== 1) throw new Error("The reviewed_by_person_id must have an active explicit platform super_admin grant");
  for (const account of review.accounts) if (people.get(account.person_id)?.account_kind !== account.expected_account_kind) throw new Error("A reviewed account is missing or its expected kind changed; no account changes applied");
  const changed = review.accounts.filter(account => account.account_kind !== people.get(account.person_id).account_kind);
  let revokedSessions = 0;
  for (const account of changed) {
    await connection.execute("UPDATE people SET account_kind = ? WHERE id = ?", [account.account_kind, account.person_id]);
    await connection.execute(`INSERT INTO people_account_kind_audit (person_id, previous_kind, account_kind, reviewed_by_person_id, reason, reviewed_at)
      VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`, [account.person_id, account.expected_account_kind, account.account_kind, review.reviewed_by_person_id, review.reason]);
    const [removed] = await connection.execute("DELETE FROM sessions WHERE person_id = ?", [account.person_id]);
    revokedSessions += Number(removed.affectedRows || 0);
  }
  return { changed_person_ids: changed.map(account => account.person_id), revoked_sessions: revokedSessions };
}
