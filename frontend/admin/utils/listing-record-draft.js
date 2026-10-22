const MAX_AGE_MS = 30 * 60 * 1000;

function identity(user) {
  const person = Number(user?.personId || user?.person_id || user?.id);
  const tenant = Number(user?.tenant?.id);
  if (!Number.isSafeInteger(person) || person <= 0 || !Number.isSafeInteger(tenant) || tenant <= 0) {
    throw new Error("当前账号或企业已变化，请重新打开商品编辑");
  }
  return `${tenant}:${person}`;
}

export function storeListingRecordDraft(draft, user, storage = sessionStorage, now = Date.now()) {
  const key = `online-edit:${globalThis.crypto.randomUUID()}`;
  storage.setItem(key, JSON.stringify({ draft, identity: identity(user), created_at: now }));
  return key;
}

export function readListingRecordDraft(key, user, storage = sessionStorage, now = Date.now()) {
  const saved = JSON.parse(storage.getItem(key) || "null");
  if (!saved || saved.identity !== identity(user) || !Number.isFinite(saved.created_at)
    || now < saved.created_at || now - saved.created_at > MAX_AGE_MS || !saved.draft?.template) {
    throw new Error("商品编辑缓存已失效或不属于当前账号与企业，请从商品列表重新打开");
  }
  return saved.draft;
}
