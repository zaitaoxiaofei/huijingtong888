import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const WEAK_PASSWORDS = new Set([
  "123456",
  "12345678",
  "123456789",
  "password",
  "qwerty123",
  "admin123",
  "88888888"
]);

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64, { N: 16384 }).toString("hex");
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(input, storedHash) {
  if (!storedHash) return false;

  if (storedHash.startsWith("scrypt:")) {
    const parts = storedHash.split(":");
    if (parts.length !== 3) return false;
    const [, salt, key] = parts;
    const inputKey = scryptSync(input, salt, 64, { N: 16384 }).toString("hex");
    try {
      return timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(inputKey, "hex"));
    } catch {
      return false;
    }
  }

  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const inputHash = createHash("sha256").update(salt + input).digest("hex");
  return inputHash === hash;
}

export function isLegacyHash(storedHash) {
  return storedHash && !storedHash.startsWith("scrypt:");
}

export function validatePasswordStrength(password, context = {}) {
  const value = String(password || "");
  const normalized = value.trim().toLowerCase();
  const username = String(context.username || "").trim().toLowerCase();
  const name = String(context.name || "").trim().toLowerCase();

  if (!value) throw new Error("密码不能为空");
  if (value.length < 8) throw new Error("密码至少需要 8 位");
  if (WEAK_PASSWORDS.has(normalized)) throw new Error("密码过于简单，请更换更安全的密码");
  if (/^\d+$/.test(value)) throw new Error("密码不能只包含数字");
  if (username && normalized.includes(username)) throw new Error("密码不能包含登录名");
  if (name && name.length >= 3 && normalized.includes(name)) throw new Error("密码不能包含姓名");
  return true;
}
