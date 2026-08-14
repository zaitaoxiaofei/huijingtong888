import crypto from "node:crypto";

const VERSION = "v1";

function text(value) {
  return String(value ?? "").trim();
}

function encryptionKeys() {
  const seeds = [
    process.env.SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY,
    process.env.AI_CONFIG_SECRET,
    process.env.SITE_ACCESS_PASSWORD,
    "ozon-erp-local-seller-analytics-auth"
  ].map(text).filter(Boolean);
  return Array.from(new Set(seeds)).map((seed) => crypto.createHash("sha256").update(seed, "utf8").digest());
}

export function encryptSellerAuthSession(value = "") {
  const session = text(value);
  if (!session) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeys()[0], iv);
  const encrypted = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSellerAuthSession(value = "") {
  const [version, iv, tag, encrypted] = text(value).split(":");
  if (version !== VERSION || !iv || !tag || !encrypted) return "";
  for (const key of encryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      continue;
    }
  }
  return "";
}
