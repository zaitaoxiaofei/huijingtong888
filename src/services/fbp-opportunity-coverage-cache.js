// FBP suggestions are a read model. Purchase and fulfillment writers keep using
// the uncached tenant coverage loader and its existing transaction boundaries.
export function createFbpOpportunityCoverageReader({ load, revision, now = Date.now }) {
  const entries = new Map();
  return async function read(scope, { fresh = false } = {}) {
    if (!Number.isSafeInteger(scope?.id) || scope.id <= 0 || typeof scope.isDefault !== 'boolean') throw new Error('Invalid FBP coverage enterprise scope');
    const key = `${scope.id}:${scope.isDefault ? 1 : 0}`, epoch = revision();
    const previous = entries.get(key);
    if (previous?.epoch === epoch) {
      if (previous.pending) return previous.pending;
      if (!fresh && previous.expires > now()) return previous.value;
    }
    if (entries.size >= 8 && !entries.has(key)) entries.delete(entries.keys().next().value);
    const entry = { epoch };
    entries.set(key, entry);
    entry.pending = (async () => {
      const value = await load(scope);
      if (entries.get(key) === entry && revision() === epoch) {
        entry.value = value;
        entry.expires = now() + 20_000;
      } else if (entries.get(key) === entry) entries.delete(key);
      return value;
    })();
    try { return await entry.pending; }
    catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    } finally { entry.pending = null; }
  };
}
