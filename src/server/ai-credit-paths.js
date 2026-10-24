export function isAiCreditReadRoute(parts, method = "GET") {
  if (method !== "GET" || parts[0] !== "api" || parts[1] !== "ai-credits") return false;
  return parts.length === 3 && ["wallet", "entries", "audit"].includes(parts[2])
    || parts.length === 4 && parts[2] === "tasks" && /^[0-9a-f-]{36}$/.test(parts[3]);
}
