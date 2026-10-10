export function createSystemNotificationRoutes({ services }) {
  return {
    "GET /api/system-notifications": (req, url) => services.listSystemNotifications(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/system-notifications/read-all": (req) => services.markAllSystemNotificationsRead(req._session)
  };
}

export async function handleSystemNotificationRestRoute({ req, res, parts, services, json }) {
  if (parts[0] !== "api" || parts[1] !== "system-notifications" || !parts[2]) return false;
  if (req.method === "POST" && parts[3] === "read") {
    return json(res, await services.markSystemNotificationRead(parts[2], req._session));
  }
  if (req.method === "POST" && parts[3] === "resolve") {
    return json(res, await services.resolveSystemNotification(parts[2], req._session));
  }
  return false;
}
