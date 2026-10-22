const ROUTES = new Set([
  'GET bootstrap', 'PUT settings', 'POST preview', 'POST batches',
  'GET batches', 'GET batch', 'POST action', 'GET file'
]);

export function isOglDispatchRoute(parts, method = 'GET') {
  return parts[0] === 'api' && parts[1] === 'ogl-dispatch' && parts.length === 3
    && ROUTES.has(`${String(method).toUpperCase()} ${parts[2]}`);
}
