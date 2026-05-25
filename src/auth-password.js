import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
