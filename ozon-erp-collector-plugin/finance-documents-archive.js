(function (root) {
  'use strict';
  const core = root.OzonFinanceDocuments;
  const INDEX = '_Ozon原件索引.json';
  const sectionKey = s => s.folder.id + '/' + s.section[0];
  const key = m => [m.tenant_id, m.company?.id, m.shop?.id, m.month, m.language].join('|');
  const clock = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const digest = async file => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
  function basePath(context, binding) {
    return [core.safeName(binding.company.name) + '__' + binding.company.id,
      core.safeName(context.shop.name) + '__' + context.shop.id, binding.month].join('/');
  }
  function filePath(manifest, item, doc, filename) {
    const relative = core.pathFor('unused', manifest.month, item.folder, item.section[0], doc, manifest.language + '_' + filename).split('/').slice(2).join('/');
    return manifest.base_path + '/' + relative;
  }
  async function parent(directory, path, create = false) {
    const parts = String(path).split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p))) throw new Error('归档清单含有非法路径，请核对保存目录');
    let handle = directory;
    for (const part of parts.slice(0, -1)) handle = await handle.getDirectoryHandle(part, { create });
    return { handle, name: parts.at(-1) };
  }
  async function readFile(directory, path) {
    const { handle, name } = await parent(directory, path);
    return (await handle.getFileHandle(name)).getFile();
  }
  async function ensureDirectory(directory, path) { await parent(directory, path + '/_directory', true); }
  async function readJson(directory, path) {
    try {
      const file = await readFile(directory, path);
      if (file.size > 8 * 1024 * 1024) throw new Error('归档索引超过8MB，请按年度选择独立保存目录');
      return JSON.parse(await file.text());
    } catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
  }
  async function writeFile(directory, path, blob, overwrite = false) {
    const { handle, name } = await parent(directory, path, true);
    let old;
    try { old = await (await handle.getFileHandle(name)).getFile(); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    if (old && old.size === blob.size && await digest(old) === await digest(blob)) return;
    if (old && !overwrite) throw new Error('存在同名但内容不同的文件，请选择“全部重新下载并覆盖”后重试');
    const writer = await (await handle.getFileHandle(name, { create: true })).createWritable();
    try { await writer.write(blob); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
  }
  function createMonth(context, binding, language) {
    return { schema_version: 2, tenant_id: context.tenant_id, company: binding.company, shop: context.shop,
      ozon_company_id: context.shop.ozon_company_id, month: binding.month, language,
      base_path: basePath(context, binding), month_basis: 'Ozon文件列表日期', collected_timezone: 'Asia/Shanghai',
      updated_at: clock(), read_completed: false, complete: false, sections: [] };
  }
  function snapshotComplete(manifest) {
    const expected = new Set(core.folders.flatMap(f => f.sections.map(s => f.id + '/' + s[0])));
    const sections = manifest.sections || [], docs = sections.flatMap(s => s.documents || []);
    return manifest.read_completed !== false && manifest.binding_verified !== false && sections.length === expected.size
      && sections.every(s => expected.delete(sectionKey(s)) && !s.error && s.selected !== false)
      && expected.size === 0 && docs.length > 0 && docs.every(d => d.saved && !d.error && d.path && /^[a-f0-9]{64}$/.test(d.sha256));
  }
  async function inspect(directory, context, binding, language) {
    const target = createMonth(context, binding, language), index = await readJson(directory, INDEX);
    const stored = index?.records?.find(r => r.key === key(target));
    const paths = [...new Set([target.base_path + '/归档清单_' + language + '.json', stored?.manifest_path,
      context.shop.ozon_company_id + '/' + binding.month + '/采集清单.json'].filter(Boolean))];
    // Version 1.5.8 used timestamped manifests in the seller-ID folder.
    try {
      const legacy = await directory.getDirectoryHandle(context.shop.ozon_company_id), month = await legacy.getDirectoryHandle(binding.month);
      for await (const entry of month.values()) if (/^采集清单_\d+\.json$/.test(entry.name)) paths.push(context.shop.ozon_company_id + '/' + binding.month + '/' + entry.name);
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    let best = { status: 'missing', verified: [], target };
    for (const path of paths) {
      let m;
      try { m = await readJson(directory, path); } catch (error) { best.error = '已有清单不能读取：' + error.message; continue; }
      if (!m || m.month !== binding.month) continue;
      const modern = m.schema_version === 2;
      if (modern ? key(m) !== key(target) || String(m.ozon_company_id) !== String(context.shop.ozon_company_id)
        : String(m.company_id || m.company) !== String(context.shop.ozon_company_id) || (m.language || 'ru') !== language) continue;
      const verified = [];
      for (const item of m.sections || []) for (const doc of item.documents || []) {
        if (!doc.saved || !doc.path || !/^[a-f0-9]{64}$/.test(doc.sha256)) continue;
        const prefix = modern ? m.base_path + '/' : context.shop.ozon_company_id + '/' + binding.month + '/';
        if (!doc.path.startsWith(prefix)) continue;
        try {
          const file = await readFile(directory, doc.path);
          if (file.size > 40 * 1024 * 1024 || (doc.bytes != null && file.size !== doc.bytes) || await digest(file) !== doc.sha256) continue;
          verified.push({ item, doc });
        } catch (error) { if (error.name !== 'NotFoundError') throw error; }
      }
      const total = (m.sections || []).reduce((n, s) => n + (s.documents || []).length, 0);
      const complete = snapshotComplete(m) && verified.length === total;
      const candidate = { status: complete ? 'complete' : 'partial', target, manifest: m, verified, manifest_path: path,
        needs_relocate: !modern || m.base_path !== target.base_path, checked_at: clock() };
      if (complete || verified.length > best.verified.length || !best.manifest) best = candidate;
      if (complete) break;
    }
    return best;
  }
  async function checkpoint(directory, manifest) {
    manifest.updated_at = clock(); manifest.complete = snapshotComplete(manifest);
    const manifestPath = manifest.base_path + '/归档清单_' + manifest.language + '.json';
    await writeFile(directory, manifestPath, new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), true);
    const index = await readJson(directory, INDEX) || { schema_version: 2, records: [] };
    if (index.schema_version !== 2 || !Array.isArray(index.records)) throw new Error('本地归档总索引格式异常，请先核对_Ozon原件索引.json');
    const record = { key: key(manifest), tenant_id: manifest.tenant_id, company: manifest.company, shop: manifest.shop,
      month: manifest.month, language: manifest.language, complete: manifest.complete,
      manifest_path: manifestPath, updated_at: manifest.updated_at, files: manifest.sections.flatMap(s => (s.documents || []).filter(d => d.saved).map(d => ({
        evidence_id: [manifest.tenant_id, manifest.company.id, manifest.shop.id, manifest.month, core.documentKey(d)].join('|'),
        document_id: d.id, document_type: d.document_type?.code, source_folder: s.folder.name, source_section: s.section[0],
        original_name: d.file_name || d.download_name, path: d.path, sha256: d.sha256, bytes: d.bytes
      }))) };
    index.records = index.records.filter(r => r.key !== record.key).concat(record);
    await writeFile(directory, INDEX, new Blob([JSON.stringify(index, null, 2)], { type: 'application/json' }), true);
  }
  root.OzonFinanceArchive = { basePath, filePath, readFile, readJson, writeFile, ensureDirectory, createMonth, inspect, checkpoint, snapshotComplete, sectionKey, digest };
})(globalThis);
