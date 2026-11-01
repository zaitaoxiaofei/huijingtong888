import {AsyncLocalStorage} from 'node:async_hooks';
const reads = new AsyncLocalStorage();
export function withRequestReadCache(operation) {
  return reads.getStore() ? operation() : reads.run(new Map(),operation);
}
// No values survive a request; an enterprise disabled between requests must
// be rejected by the next request rather than using a process-wide cache.
export function memoRequestRead(key,loader) {
  const cache=reads.getStore();
  if(!cache)return Promise.resolve().then(loader);
  if(cache.has(key))return cache.get(key);
  const value=Promise.resolve().then(loader).catch(error=>{if(cache.get(key)===value)cache.delete(key);throw error;});
  cache.set(key,value);return value;
}
