import { randomUUID } from "node:crypto";

const TERMINAL_RESERVE = 1024;

function fail(code, message, status = 409) {
  throw Object.assign(new Error(message), { code, status, statusCode: status });
}

function text(value, bytes = 128) {
  const source = String(value ?? "").trim();
  if (Buffer.byteLength(source) <= bytes) return source;
  let result = "", used = 0;
  for (const character of source) {
    used += Buffer.byteLength(character);
    if (used > bytes) break;
    result += character;
  }
  return result;
}

function required(value, name) {
  const result = text(value);
  if (!result || result !== String(value).trim()) fail("COLLECTOR_BROWSER_INPUT_INVALID", `Invalid ${name}`, 400);
  return result;
}

function limit(value, fallback, maximum = Infinity) {
  return Math.min(maximum, Math.max(1, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bytes(value) { return Buffer.byteLength(JSON.stringify(value)); }

export class CollectorBrowserPool {
  constructor({ clock = Date.now, workerTtlMs = 60000, leaseMs = 90000, batchTtlMs = 180000,
    cacheTtlMs = 300000, maxActive = 6, maxBatches = 64, maxWorkers = 256,
    maxResultBytes = 32 * 1024 * 1024, maxResultItemBytes = 256 * 1024,
    maxCacheEntries = 512, maxSkus = 48, maxAttempts = 3, cooldownMs = 60000 } = {}) {
    this.clock = clock;
    this.workerTtlMs = limit(workerTtlMs, 60000);
    this.leaseMs = limit(leaseMs, 90000);
    this.batchTtlMs = limit(batchTtlMs, 180000);
    this.cacheTtlMs = limit(cacheTtlMs, 300000);
    this.maxActive = limit(maxActive, 6, 6);
    this.maxBatches = limit(maxBatches, 64);
    this.maxWorkers = limit(maxWorkers, 256);
    this.maxResultBytes = limit(maxResultBytes, 32 * 1024 * 1024);
    this.maxResultItemBytes = limit(maxResultItemBytes, 256 * 1024);
    this.maxCacheEntries = limit(maxCacheEntries, 512);
    this.maxSkus = limit(maxSkus, 48, 120);
    this.maxAttempts = limit(maxAttempts, 3, 5);
    this.cooldownMs = limit(cooldownMs, 60000);
    this.workers = new Map();
    this.companies = new Map();
    this.batches = new Map();
    this.tasks = new Map();
    this.cache = new Map();
    this.cursors = new Map();
    this.resultBytes = 0;
    this.reservedBytes = 0;
  }

  _key(tenant, id) { return JSON.stringify([tenant, id]); }
  _now() {
    const now = Number(this.clock());
    if (!Number.isFinite(now)) throw new Error("Invalid collector browser pool clock");
    return now;
  }
  _company(tenant, company) {
    const key = this._key(tenant, company);
    if (!this.companies.has(key)) this.companies.set(key, { tenant, company, active: null, cooldownUntil: 0 });
    return this.companies.get(key);
  }
  _liveCompanies(tenant, now) {
    const result = new Map();
    for (const worker of this.workers.values()) {
      if (worker.tenant !== tenant || worker.expiresAt <= now) continue;
      if (this._company(tenant, worker.company).cooldownUntil > now) continue;
      result.set(worker.company, worker);
    }
    return [...result.values()].sort((a, b) => a.company.localeCompare(b.company));
  }
  _release(task) {
    const company = task.company && this.companies.get(this._key(task.tenant, task.company));
    if (company?.active === task.id) company.active = null;
    task.worker = null;
    task.lease = null;
    task.leaseUntil = 0;
  }
  _removeResult(task) {
    const batch = this.batches.get(task.batch);
    if (batch.results.has(task.sku)) {
      this.resultBytes -= batch.resultSizes.get(task.sku);
      batch.resultSizes.delete(task.sku);
      batch.results.delete(task.sku);
      batch.revision += 1;
    }
  }
  _dropCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.resultBytes -= entry.size;
    this.cache.delete(key);
  }
  _room(extra, releasedReserve = 0) {
    while (this.resultBytes + this.reservedBytes + extra - releasedReserve > this.maxResultBytes && this.cache.size) {
      this._dropCache(this.cache.keys().next().value);
    }
    if (this.resultBytes + this.reservedBytes + extra - releasedReserve > this.maxResultBytes) {
      fail("COLLECTOR_BROWSER_CAPACITY", "Collector browser result capacity reached", 429);
    }
  }
  _result(task, { success, partial, product = {}, warnings = [], error, status }, final = false) {
    const batch = this.batches.get(task.batch);
    const result = {
      sku: task.sku, success, partial, product,
      source_shop_id: task.shopId || null, source_shop_name: task.shopName || "",
      source_company_id: task.company || "", warnings,
      ...(error ? { error: text(error, 200) } : {}),
      ...(status ? { status: Number(status) } : {}), revision: batch.revision + 1
    };
    const size = bytes(result);
    if (size > this.maxResultItemBytes && success) fail("COLLECTOR_BROWSER_RESULT_TOO_LARGE", "Collector browser result is too large", 413);
    this._room(size - (batch.resultSizes.get(task.sku) || 0), final ? task.reserve : 0);
    this.resultBytes += size - (batch.resultSizes.get(task.sku) || 0);
    batch.results.set(task.sku, result);
    batch.resultSizes.set(task.sku, size);
    batch.revision += 1;
    if (final) {
      this.reservedBytes -= task.reserve;
      task.reserve = 0;
    }
    return result;
  }
  _finishFailed(task, error, status) {
    this._release(task);
    this._result(task, { success: false, partial: false, error, status }, true);
    task.state = "failed";
  }
  _retry(task, error, status) {
    this._release(task);
    this._removeResult(task);
    if (task.attempts >= this.maxAttempts) return this._finishFailed(task, error, status);
    task.state = "pending";
    task.company = "";
    task.shopId = null;
    task.shopName = "";
    this.batches.get(task.batch).revision += 1;
  }
  _batchState(batch) {
    const tasks = batch.tasks.map(id => this.tasks.get(id));
    const completed = tasks.filter(task => task.state === "complete").length;
    const failed = tasks.filter(task => task.state === "failed").length;
    return {
      status: completed + failed === tasks.length ? (failed ? "failed" : "complete")
        : tasks.some(task => task.attempts || task.state === "complete") ? "running" : "pending",
      completed, failed
    };
  }
  _evictBatch(batch) {
    for (const id of batch.tasks) {
      const task = this.tasks.get(id);
      this._release(task);
      this.reservedBytes -= task.reserve;
      this.tasks.delete(id);
    }
    for (const size of batch.resultSizes.values()) this.resultBytes -= size;
    this.batches.delete(batch.id);
  }
  _sweep(now) {
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this._dropCache(key);
    for (const [key, worker] of this.workers) if (worker.expiresAt <= now) this.workers.delete(key);
    for (const batch of this.batches.values()) {
      if (batch.expiresAt <= now) {
        for (const id of batch.tasks) {
          const task = this.tasks.get(id);
          if (!["complete", "failed"].includes(task.state)) this._finishFailed(task, "Collector browser batch expired", 504);
        }
        batch.purgeAt ??= now + this.batchTtlMs;
        if (batch.purgeAt <= now) this._evictBatch(batch);
        continue;
      }
      for (const id of batch.tasks) {
        const task = this.tasks.get(id);
        if (task.state !== "running") continue;
        const worker = this.workers.get(this._key(task.tenant, task.worker));
        if (!worker || worker.company !== task.company || task.leaseUntil <= now) {
          this._retry(task, "Collector browser worker or lease expired", 504);
        }
      }
    }
    for (const [key, company] of this.companies) {
      if (company.active || company.cooldownUntil > now) continue;
      if (![...this.workers.values()].some(worker => worker.tenant === company.tenant && worker.company === company.company)) this.companies.delete(key);
    }
    for (const tenant of this.cursors.keys()) {
      if (![...this.workers.values(), ...this.batches.values()].some(entry => entry.tenant === tenant)) this.cursors.delete(tenant);
    }
  }
  _assign(tenant, now) {
    const candidates = this._liveCompanies(tenant, now);
    const loads = new Map(candidates.map(worker => [worker.company, 0]));
    for (const task of this.tasks.values()) if (task.tenant === tenant && ["pending", "running"].includes(task.state) && loads.has(task.company)) {
      loads.set(task.company, loads.get(task.company) + 1);
    }
    for (const task of this.tasks.values()) {
      if (task.tenant !== tenant || task.state !== "pending") continue;
      if (loads.has(task.company)) continue;
      if (!candidates.length) { task.company = ""; continue; }
      const fresh = candidates.filter(worker => !task.tried.has(worker.company));
      const pool = fresh.length ? fresh : candidates;
      const cursor = this.cursors.get(tenant) || 0;
      const ranked = pool.map(worker => ({ worker, index: candidates.indexOf(worker) }))
        .sort((a, b) => Number(Boolean(this._company(tenant, a.worker.company).active)) - Number(Boolean(this._company(tenant, b.worker.company).active))
          || loads.get(a.worker.company) - loads.get(b.worker.company)
          || (a.index - cursor + candidates.length) % candidates.length - (b.index - cursor + candidates.length) % candidates.length);
      const selected = ranked[0];
      task.company = selected.worker.company;
      task.shopId = selected.worker.shopId;
      task.shopName = selected.worker.shopName;
      loads.set(task.company, loads.get(task.company) + 1);
      this.cursors.set(tenant, (selected.index + 1) % candidates.length);
    }
  }

  heartbeat(tenantKey, metadata = {}) {
    const tenant = required(tenantKey, "tenant");
    const workerId = required(metadata.worker_id, "worker_id");
    const company = required(metadata.company_id, "company_id");
    const page = text(metadata.page_company_id), cookie = text(metadata.cookie_company_id), observed = text(metadata.observed_company_id);
    if (!page || !cookie || page !== company || cookie !== company || (observed ? observed !== company : metadata.identity_source !== "page_cookie")) {
      fail("COLLECTOR_BROWSER_IDENTITY_MISMATCH", "Collector browser live shop identity does not match", 403);
    }
    const shopId = Number(metadata.shop_id);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) fail("COLLECTOR_BROWSER_INPUT_INVALID", "Invalid reviewed shop_id", 400);
    const now = this._now();
    this._sweep(now);
    const key = this._key(tenant, workerId);
    if (!this.workers.has(key) && this.workers.size >= this.maxWorkers) fail("COLLECTOR_BROWSER_CAPACITY", "Collector browser worker capacity reached", 429);
    this.workers.set(key, {
      tenant, id: workerId, company, shopId, shopName: text(metadata.shop_name, 128),
      identitySource: text(metadata.identity_source || "observed_headers"),
      version: text(metadata.plugin_version, 32), seenAt: now, expiresAt: now + this.workerTtlMs
    });
    this._company(tenant, company);
    this._assign(tenant, now);
    return { success: true, worker_id: workerId, ...this.status(tenant) };
  }

  createBatch(tenantKey, skus = []) {
    const tenant = required(tenantKey, "tenant");
    if (!Array.isArray(skus)) fail("COLLECTOR_BROWSER_INPUT_INVALID", "SKUs must be an array", 400);
    const normalized = [...new Set(skus.map(sku => required(sku, "sku")))];
    if (!normalized.length || normalized.length > this.maxSkus) fail("COLLECTOR_BROWSER_INPUT_INVALID", "Invalid collector browser SKU count", 400);
    const now = this._now();
    this._sweep(now);
    const cached = new Map(normalized.map(sku => [sku, this.cache.get(this._key(tenant, sku))]));
    if (normalized.some(sku => !cached.get(sku)) && !this._liveCompanies(tenant, now).length) {
      fail("COLLECTOR_BROWSER_POOL_UNAVAILABLE", "No verified collector browser workers are available", 409);
    }
    const reserve = normalized.filter(sku => !cached.get(sku)).length * TERMINAL_RESERVE;
    while (this.batches.size >= this.maxBatches) {
      const finished = [...this.batches.values()].find(batch => ["complete", "failed"].includes(this._batchState(batch).status));
      if (!finished) fail("COLLECTOR_BROWSER_CAPACITY", "Collector browser batch capacity reached", 429);
      this._evictBatch(finished);
    }
    // Capture hits before capacity eviction removes cache entries.
    const hits = new Map([...cached].map(([sku, entry]) => [sku, entry ? clone(entry.result) : null]));
    const batch = { id: randomUUID(), tenant, tasks: [], results: new Map(), resultSizes: new Map(), revision: 1, expiresAt: now + this.batchTtlMs };
    const tasks = [];
    let resultSize = 0;
    for (const sku of normalized) {
      const hit = hits.get(sku);
      const task = {
        id: randomUUID(), batch: batch.id, tenant, sku, state: hit ? "complete" : "pending",
        attempts: 0, tried: new Set(), company: hit?.source_company_id || "", shopId: hit?.source_shop_id || null,
        shopName: hit?.source_shop_name || "", worker: null, lease: null, leaseUntil: 0, reserve: hit ? 0 : TERMINAL_RESERVE
      };
      tasks.push(task);
      batch.tasks.push(task.id);
      if (hit) {
        hit.revision = ++batch.revision;
        const size = bytes(hit);
        if (size > this.maxResultItemBytes) fail("COLLECTOR_BROWSER_RESULT_TOO_LARGE", "Collector browser cached result is too large", 413);
        batch.results.set(sku, hit);
        batch.resultSizes.set(sku, size);
        resultSize += size;
      }
    }
    this._room(reserve + resultSize);
    this.batches.set(batch.id, batch);
    for (const task of tasks) this.tasks.set(task.id, task);
    this.reservedBytes += reserve;
    this.resultBytes += resultSize;
    this._assign(tenant, now);
    return this.batchStatus(tenant, batch.id);
  }

  batchStatus(tenantKey, batchId, afterRevision = 0) {
    const tenant = required(tenantKey, "tenant"), now = this._now();
    this._sweep(now);
    const batch = this.batches.get(String(batchId));
    if (!batch || batch.tenant !== tenant) fail("COLLECTOR_BROWSER_BATCH_NOT_FOUND", "Collector browser batch not found", 404);
    this._assign(tenant, now);
    const state = this._batchState(batch);
    return {
      batch_id: batch.id, status: state.status, revision: batch.revision, total_count: batch.tasks.length,
      completed_count: state.completed, failed_count: state.failed,
      results: [...batch.results.values()].filter(result => result.revision > Number(afterRevision || 0)).map(clone)
    };
  }

  claim(tenantKey, { worker_id, company_id } = {}) {
    const tenant = required(tenantKey, "tenant"), workerId = required(worker_id, "worker_id"), company = required(company_id, "company_id");
    const now = this._now();
    this._sweep(now);
    const worker = this.workers.get(this._key(tenant, workerId));
    if (!worker || worker.company !== company) fail("COLLECTOR_BROWSER_WORKER_UNAVAILABLE", "Collector browser worker identity is unavailable", 409);
    const slot = this._company(tenant, company);
    if (slot.active || slot.cooldownUntil > now || [...this.tasks.values()].filter(task => task.tenant === tenant && task.state === "running").length >= this.maxActive) return { task: null };
    this._assign(tenant, now);
    const pending = [...this.tasks.values()].filter(task => task.tenant === tenant && task.state === "pending");
    const task = pending.find(task => task.company === company)
      || pending.find(task => this._company(tenant, task.company).active);
    if (!task) return { task: null };
    task.company = company;
    task.shopId = worker.shopId;
    task.shopName = worker.shopName;
    task.worker = workerId;
    task.lease = randomUUID();
    task.leaseUntil = now + this.leaseMs;
    task.state = "running";
    task.attempts += 1;
    task.tried.add(company);
    slot.active = task.id;
    this.batches.get(task.batch).revision += 1;
    return { task: {
      task_id: task.id, batch_id: task.batch, sku: task.sku, company_id: company,
      shop_id: task.shopId, shop_name: task.shopName, lease_token: task.lease,
      lease_expires_at: new Date(task.leaseUntil).toISOString()
    } };
  }

  report(tenantKey, body = {}) {
    const tenant = required(tenantKey, "tenant"), now = this._now();
    this._sweep(now);
    const task = this.tasks.get(String(body.task_id));
    const worker = this.workers.get(this._key(tenant, String(body.worker_id)));
    if (!task || task.tenant !== tenant || task.state !== "running" || !worker || worker.company !== task.company
      || task.worker !== body.worker_id || task.company !== body.company_id || task.sku !== body.sku
      || !body.lease_token || task.lease !== body.lease_token || task.leaseUntil <= now) {
      fail("COLLECTOR_BROWSER_LEASE_INVALID", "Collector browser task lease or shop identity is invalid", 409);
    }
    if (!["sales", "complete", "failed"].includes(body.phase)) fail("COLLECTOR_BROWSER_INPUT_INVALID", "Invalid collector browser result phase", 400);
    const warnings = (Array.isArray(body.warnings) ? body.warnings : []).slice(0, 20).map(warning => text(warning, 300));
    if (body.phase === "failed") {
      const status = Number(body.status || 0);
      if ([401, 403, 429].includes(status)) this._company(tenant, task.company).cooldownUntil = now + this.cooldownMs;
      this._retry(task, text(body.error || "Collector browser request failed", 200), status);
      this._assign(tenant, now);
      return this.batchStatus(tenant, task.batch);
    }
    if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) fail("COLLECTOR_BROWSER_INPUT_INVALID", "Collector browser fields must be an object", 400);
    let serialized;
    try { serialized = JSON.stringify(body.fields); } catch { fail("COLLECTOR_BROWSER_INPUT_INVALID", "Collector browser fields must be JSON", 400); }
    if (!serialized || Buffer.byteLength(serialized) > this.maxResultItemBytes) fail("COLLECTOR_BROWSER_RESULT_TOO_LARGE", "Collector browser fields are too large", 413);
    const fields = JSON.parse(serialized);
    const pending = [fields];
    while (pending.length) {
      for (const [key, value] of Object.entries(pending.pop())) {
        if (/^(?:cookies?|cookie_header|cookieHeader|authorization|access_token|accessToken|refresh_token|refreshToken|local_plugin_token|localPluginToken|lease_token|leaseToken|request_headers|requestHeaders|response_headers|responseHeaders)$/i.test(key)) {
          fail("COLLECTOR_BROWSER_INPUT_INVALID", "Collector browser fields must not contain credentials", 400);
        }
        if (value && typeof value === "object") pending.push(value);
      }
    }
    const complete = body.phase === "complete";
    const result = this._result(task, { success: true, partial: !complete, product: fields, warnings }, complete);
    if (complete) {
      task.state = "complete";
      this._release(task);
      const key = this._key(tenant, task.sku), size = bytes(result);
      this._dropCache(key);
      while (this.cache.size >= this.maxCacheEntries) this._dropCache(this.cache.keys().next().value);
      if (this.resultBytes + this.reservedBytes + size <= this.maxResultBytes) {
        this.cache.set(key, { result: clone(result), size, expiresAt: now + this.cacheTtlMs });
        this.resultBytes += size;
      }
    }
    return this.batchStatus(tenant, task.batch);
  }

  status(tenantKey) {
    const tenant = required(tenantKey, "tenant"), now = this._now();
    this._sweep(now);
    const workers = [...this.workers.values()].filter(worker => worker.tenant === tenant).map(worker => ({
      worker_id: worker.id, company_id: worker.company, shop_id: worker.shopId, shop_name: worker.shopName,
      plugin_version: worker.version, identity_source: worker.identitySource,
      last_seen_at: worker.seenAt, expires_at: worker.expiresAt,
      cooldown_until: this._company(tenant, worker.company).cooldownUntil,
      active_tasks: Number(Boolean(this._company(tenant, worker.company).active))
    }));
    return { enabled: this._liveCompanies(tenant, now).length > 0, available_workers: this._liveCompanies(tenant, now).length, workers };
  }
}
