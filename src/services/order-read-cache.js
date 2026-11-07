import { workflowRevision } from './inventory-workflow-cache.js';

const cache = new Map(), pending = new Map();
const MAX_ENTRIES = 80;
let revision = 0, nextIdentity = 0;
const identities = new WeakMap();
export function orderReadIdentity(value) {
  if (value === null || typeof value !== 'object') return 0;
  if (!identities.has(value)) identities.set(value, ++nextIdentity);
  return identities.get(value);
}
const version = () => `${revision}:${workflowRevision()}`;
export function invalidateOrderReadCache() {
  revision++;
  cache.clear();
  pending.clear();
}
// Keys are made only after resolving the enterprise. Writes invalidate through
// the shared workflow revision; late results cannot repopulate a new revision.
export async function cachedOrderRead(key, loader, ttlMs = 15000) {
  const generation = version(), scopedKey = `${generation}:${key}`;
  const found = cache.get(scopedKey);
  if (found && found.until > Date.now()) return found.value;
  if (pending.has(scopedKey)) return pending.get(scopedKey);
  const work = Promise.resolve().then(loader).then(value => {
    if (generation === version() && pending.get(scopedKey) === work) {
      const now = Date.now();
      for (const [key,entry] of cache) if (entry.until <= now) cache.delete(key);
      cache.set(scopedKey,{value,until:now+ttlMs});
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
    return value;
  }).finally(() => { if (pending.get(scopedKey) === work) pending.delete(scopedKey); });
  pending.set(scopedKey, work);
  return work;
}
