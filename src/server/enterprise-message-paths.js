const readActions = new Set(["contacts", "conversations", "unread", "thread", "references", "reference"]);
const writeActions = new Set(["send", "read"]);

export function isEnterpriseMessageRoute(parts, method) {
  return parts.length === 4 && parts[0] === "api" && parts[1] === "enterprise" && parts[2] === "messages"
    && (method === "GET" ? readActions.has(parts[3]) : method === "POST" && writeActions.has(parts[3]));
}
