import fs from "node:fs/promises";
import path from "node:path";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { resolveUploadSubdirRoots } from "../runtime-uploads.js";
import { hasPermission } from "../shared/permissions.js";
import { authorizeBusinessTaskSession } from "./business-task-tenant.js";

export { TENANT_PRIVATE_FILES_SCHEMA } from "./tenant-private-files-schema.js";

const PREFIX = "/uploads/team-attachments/";
function fail(message, statusCode = 404) { throw Object.assign(new Error(message), { statusCode }); }
export function isPrivateAttachmentPath(pathname) {
  try { return decodeURIComponent(String(pathname)).replace(/\\/g, "/").toLowerCase().startsWith(PREFIX); }
  catch { return String(pathname).toLowerCase().startsWith(PREFIX); }
}
function storageName(url) {
  let decoded;
  try { decoded = decodeURIComponent(String(url)); } catch { fail("附件地址无效"); }
  if (!decoded.startsWith(PREFIX)) fail("请使用当前企业上传的附件", 400);
  const name = decoded.slice(PREFIX.length);
  if (!name || name.length > 255 || /[/\\\x00-\x1f?#%]/.test(name) || name === "." || name === "..") fail("附件地址无效");
  return name;
}
function permitted(session, purpose) {
  return hasPermission(session, purpose === "finance" ? "finance" : "team");
}

export function createTenantPrivateFiles({ query = mysqlQuery, execute = mysqlExecute, authorize = authorizeBusinessTaskSession,
  roots = [...new Set([...resolveUploadSubdirRoots("team-attachments"), path.resolve("public", "uploads", "team-attachments")])] } = {}) {
  async function actor(session, purpose) {
    const current = await authorize(session);
    if (!permitted(current, purpose)) fail("当前企业岗位无权访问此类附件", 403);
    return current;
  }
  async function owned(url, session, purpose) {
    const name = storageName(url);
    const current = await authorize(session);
    const [row] = await query("SELECT * FROM tenant_private_files WHERE storage_name = ? AND tenant_id = ? LIMIT 1", [name, Number(current.tenant.id)]);
    if (!row || (purpose && row.purpose !== purpose)) fail("附件不存在或不属于当前企业");
    if (!permitted(current, row.purpose)) fail("当前企业岗位无权访问此类附件", 403);
    return row;
  }
  return {
    async register(file, session, purpose) {
      if (!["team", "finance"].includes(purpose)) fail("附件用途无效", 400);
      const current = await actor(session, purpose);
      const name = storageName(`${PREFIX}${file.storageName}`);
      await execute(`INSERT INTO tenant_private_files
        (tenant_id, storage_name, original_name, purpose, content_type, byte_size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [Number(current.tenant.id), name, file.name, purpose, file.contentType, file.size, current.personId]);
      return `${PREFIX}${name}`;
    },
    owned,
    async read(url, session) {
      const row = await owned(url, session);
      for (const root of roots) {
        try {
          const realRoot = await fs.realpath(root);
          const realFile = await fs.realpath(path.join(realRoot, row.storage_name));
          const relative = path.relative(realRoot, realFile);
          if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
          const stat = await fs.stat(realFile);
          if (!stat.isFile() || stat.size !== Number(row.byte_size)) continue;
          return { row, buffer: await fs.readFile(realFile) };
        } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
      }
      fail("附件不存在");
    }
  };
}

export const tenantPrivateFiles = createTenantPrivateFiles();

export async function assertFinanceAttachment(url, tenantId) {
  if (!url) return;
  const lookup = String(tenantId) === "admin" ? { sql: "slug = 'default'", params: [] } : { sql: "id = ?", params: [Number(tenantId)] };
  const [tenant] = await mysqlQuery(`SELECT id FROM tenants WHERE ${lookup.sql} AND status = 'active' LIMIT 1`, lookup.params);
  const name = storageName(url);
  const rows = tenant ? await mysqlQuery("SELECT id FROM tenant_private_files WHERE storage_name = ? AND tenant_id = ? AND purpose = 'finance' LIMIT 1", [name, Number(tenant.id)]) : [];
  if (!rows.length) fail("凭证附件不存在或不属于当前企业，请重新上传");
}
