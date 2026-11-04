import { createHash, randomUUID } from 'node:crypto';

const DAY = 86400000;
const beijingDay = now => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
export const credentialKey = shop => String(shop.ozon_api_key || shop.api_key || shop.api_key_hint || '').trim();
export const credentialVersion = shop => createHash('sha256').update(JSON.stringify([String(shop.ozon_client_id || '').trim(), credentialKey(shop)])).digest('hex');
export const healthSettingKey = (tenantId, shopId) => `ozon.health:${Number(tenantId)}:${Number(shopId)}`;

export function credentialFailure(error) {
  const text = String(error?.message || '');
  if (error?.code === 'OZON_API_KEY_INVALID' || /api[ -]?key.*(expired|invalid|revoked)|密钥.*(已过期|无效)|API Key.*(已过期|无效)/i.test(text)) return 'invalid';
  if (Number(error?.statusCode || error?.status) === 401) return 'invalid';
  if (/Offer not signed/i.test(text)) return 'offer_required';
  if (Number(error?.statusCode || error?.status) === 403) return 'forbidden';
  return 'check_failed';
}

export function expiryStage(expiresAt, now = Date.now()) {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return { state: 'unknown_expiry', days: null, stage: 'unknown_expiry' };
  const days = Math.ceil((Date.parse(expiresAt) - now) / DAY);
  if (Date.parse(expiresAt) <= now) return { state: 'expired', days: 0, stage: 'expired' };
  const threshold = [1, 3, 7, 14, 30].find(limit => days <= limit);
  return { state: threshold ? 'expiring' : 'valid', days, stage: threshold ? `within_${threshold}` : '' };
}

// Only return explicitly projected metadata, never credential fingerprints or keys.
export function publicHealth(shop, saved = {}, now = Date.now()) {
  const current = saved.version === credentialVersion(shop);
  const health = current ? saved : {};
  const expiry = expiryStage(health.expires_at, now);
  const checkState = health.check_state || (credentialKey(shop) && shop.ozon_client_id ? 'unchecked' : 'missing');
  const status = ['valid', 'unknown_expiry'].includes(checkState) ? expiry.state : checkState;
  return {
    shop_id: Number(shop.id), status, expires_at: health.expires_at || null,
    days_remaining: expiry.days, checked_at: health.checked_at || null,
    last_verified_at: health.last_verified_at || null,
    check_stale: !health.checked_at || now - Date.parse(health.checked_at) > 2 * DAY,
    roles: health.roles || [],
    sync: Object.fromEntries(Object.entries(saved.sync || {}).map(([module, value]) => [module, {
      last_attempt_at: value.last_attempt_at || null, last_success_at: value.last_success_at || null,
      status: value.status || 'unknown', coverage: value.coverage || '', last_success_coverage: value.last_success_coverage || '',
      message: value.message || '', credential_changed: value.credential_version !== credentialVersion(shop)
    }]))
  };
}

// Repository mutations serialize against the current shop row and reject replaced keys.
export function createOzonCredentialHealth({ repository, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  async function check(shop, { signal, force = false } = {}) {
    const attemptId = randomUUID();
    const started = new Date(now()).toISOString();
    const accepted = await repository.mutate(shop, saved => {
      if (!force && saved.version === credentialVersion(shop) && saved.check_started_at && now() - Date.parse(saved.check_started_at) < 60000) return null;
      return { value: { ...saved, version: credentialVersion(shop), attempt_id: attemptId, check_started_at: started } };
    });
    if (!accepted) return { skipped: true };
    let result;
    if (!shop.ozon_client_id || !credentialKey(shop) || credentialKey(shop).startsWith('demo')) {
      result = { check_state: 'missing', expires_at: null, roles: [] };
    } else {
      try {
        const response = await fetchImpl('https://api-seller.ozon.ru/v1/roles', {
          method: 'POST', headers: { 'Client-Id': String(shop.ozon_client_id), 'Api-Key': credentialKey(shop), 'Content-Type': 'application/json' },
          body: '{}', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
        });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(String(data?.message || data?.error || '')), { statusCode: response.status });
        if (!Array.isArray(data.roles) || data.roles.some(role => typeof role?.name !== 'string' || !Array.isArray(role.methods))) throw new Error('Unsupported roles response');
        const expires = data.expires_at && Number.isFinite(Date.parse(data.expires_at)) ? new Date(data.expires_at).toISOString() : null;
        result = { check_state: expires ? 'valid' : 'unknown_expiry', expires_at: expires,
          roles: data.roles.map(role => ({ name: role.name, methods: role.methods.filter(method => typeof method === 'string') })), last_verified_at: new Date(now()).toISOString() };
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        result = { check_state: credentialFailure(error) };
      }
    }
    return repository.mutate(shop, saved => {
      if (saved.attempt_id !== attemptId) return null;
      const value = { ...saved, ...result, checked_at: started };
      const view = publicHealth(shop, value, now());
      const stage = ['valid', 'expiring', 'unknown_expiry', 'expired'].includes(view.status) ? expiryStage(view.expires_at, now()).stage : view.status;
      const day = beijingDay(now());
      const daily = view.days_remaining !== null && view.days_remaining <= 7 || ['invalid', 'expired', 'missing', 'forbidden', 'offer_required', 'check_failed'].includes(view.status);
      return { value, notice: stage ? { stage, day: daily ? day : '', status: view.status, expires_at: view.expires_at, days: view.days_remaining } : null,
        resolve: ['valid', 'expiring', 'unknown_expiry'].includes(view.status), result: view };
    });
  }

  async function recordSync(shop, module, { startedAt, success, coverage, error } = {}) {
    if (!credentialKey(shop) || credentialKey(shop).startsWith('demo')) return null;
    if (!['orders', 'products', 'stocks', 'finance'].includes(module)) throw new Error('Unknown Ozon sync module');
    return repository.mutate(shop, saved => {
      const sync = { ...(saved.sync || {}) }, previous = sync[module] || {};
      if (previous.last_attempt_at && previous.last_attempt_at > startedAt) return null;
      sync[module] = { ...previous, credential_version: credentialVersion(shop), last_attempt_at: startedAt, status: success ? 'success' : 'failed', coverage,
        message: success ? '' : '本次同步未完整完成，已有数据保留；请检查授权及同步任务后重试。',
        ...(success ? { last_success_at: new Date(now()).toISOString(), last_success_coverage: coverage } : {}) };
      const failure = error && credentialFailure(error);
      const value = { ...saved, version: credentialVersion(shop), sync };
      if (failure && failure !== 'check_failed') {
        value.check_state = failure; value.checked_at = new Date(now()).toISOString(); value.attempt_id = randomUUID();
      }
      return { value, notice: failure && failure !== 'check_failed' ? { stage: failure, day: beijingDay(now()), status: failure } : null };
    });
  }
  return { check, recordSync };
}
