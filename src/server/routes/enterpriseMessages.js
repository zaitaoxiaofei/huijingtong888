export function createEnterpriseMessageRoutes({ messages, readJson }) {
  const routes = {};
  for (const action of ["contacts", "conversations", "unread", "thread", "references", "reference"]) {
    routes[`GET /api/enterprise/messages/${action}`] = (req, url) => messages[action](req._session, Object.fromEntries(url.searchParams));
  }
  for (const action of ["send", "read"]) {
    routes[`POST /api/enterprise/messages/${action}`] = async req => messages[action](req._session, await readJson(req));
  }
  return routes;
}
