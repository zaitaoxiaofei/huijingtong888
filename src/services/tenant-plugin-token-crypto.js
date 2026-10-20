import crypto from "node:crypto";

const VERSION = "v1";
const MIN_SECRET_LENGTH = 32;

function configuredSeeds() {
  return [
    process.env.TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY,
    process.env.SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY
  ].map(value => String(value || "").trim()).filter(value => value.length >= MIN_SECRET_LENGTH);
}

export function tenantPluginTokenEncryptionConfigured() {
  return configuredSeeds().length > 0;
}

function encryptionKeys() {
  const seeds = configuredSeeds();
  if (!seeds.length) {
    throw new Error("服务器未配置企业插件令牌加密密钥；请设置稳定的 TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY 后再生成或查看令牌");
  }
  return Array.from(new Set(seeds)).map(seed => crypto.createHash("sha256")
    .update(`tenant-plugin-token:${seed}`, "utf8")
    .digest());
}

export function encryptTenantPluginToken(token) {
  const value = String(token || "");
  if (!value) throw new Error("插件令牌不能为空");
  const key = encryptionKeys()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${VERSION}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptTenantPluginToken(payload) {
  const [version, iv, tag, encrypted] = String(payload || "").split(":");
  if (version !== VERSION || !iv || !tag || !encrypted) throw new Error("当前令牌为旧版凭证，无法恢复；重置后请重新配置插件");
  const encryptedBytes = Buffer.from(encrypted, "base64");
  for (const key of encryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(encryptedBytes), decipher.final()]).toString("utf8");
    } catch {
      continue;
    }
  }
  throw new Error("无法解密当前插件令牌；请确认服务器仍保留创建令牌时使用的加密密钥");
}
