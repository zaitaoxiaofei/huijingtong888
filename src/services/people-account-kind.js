// Login purpose is independent of platform grants, tenant authority and duties.
// Existing and newly registered accounts remain people until explicitly reviewed.
export const PEOPLE_ACCOUNT_KIND_COLUMN_SQL = "ALTER TABLE people ADD COLUMN account_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'person'";

export async function inspectPeopleAccountKind(query) {
  const [column] = await query("SHOW FULL COLUMNS FROM people LIKE 'account_kind'");
  if (!column) return { exists: false, ready: false };
  const ready = String(column.Type).toLowerCase() === "varchar(16)" && column.Null === "NO"
    && column.Default === "person" && column.Collation === "ascii_bin";
  return { exists: true, ready };
}

// Administrator migrations call this; application requests never perform DDL.
export async function preparePeopleAccountKind(query) {
  const before = await inspectPeopleAccountKind(query);
  if (before.exists && !before.ready) throw new Error("Existing people.account_kind schema is incompatible; manual review required");
  if (!before.exists) {
    try { await query(PEOPLE_ACCOUNT_KIND_COLUMN_SQL); }
    catch (error) { if (error.code !== "ER_DUP_FIELDNAME") throw error; }
  }
  const after = await inspectPeopleAccountKind(query);
  if (!after.ready) throw new Error("people.account_kind schema verification failed");
  return after;
}
