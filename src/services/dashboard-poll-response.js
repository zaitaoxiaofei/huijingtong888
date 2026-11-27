import { createHash } from "node:crypto";
import { dashboardForSession } from "../shared/dashboard-visibility.js";

export function dashboardPollResponse(payload, session, { statusOnly = false } = {}) {
  const visible = dashboardForSession(payload, session);
  const { revision: _previousRevision, ...snapshot } = visible.snapshot || {};
  const revision = createHash("sha256").update(JSON.stringify({ ...visible, snapshot })).digest("hex");
  const metadata = { ...snapshot, revision };
  if (!statusOnly) return { ...visible, snapshot: metadata };
  return {
    status_only: true,
    snapshot: Object.fromEntries(["status", "date_key", "refreshed_at", "source_updated_at", "revision"]
      .filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]))
  };
}
