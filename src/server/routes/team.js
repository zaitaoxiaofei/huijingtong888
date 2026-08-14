export function createTeamRoutes({ services, readJson }) {
  return {
    "GET /api/team/tasks": (req, url) => services.teamTasks(Object.fromEntries(url.searchParams.entries())),
    "POST /api/team/attachments": (req) => services.uploadTeamAttachment(req),
    "POST /api/team/tasks": async (req) => services.createTeamTask(await readJson(req), req._session?.personId)
  };
}

export async function handleTeamRestRoute({ req, res, parts, services, readJson, json }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "team" && parts[2] === "tasks" && parts[3]) {
    return json(res, await services.updateTeamTask(Number(parts[3]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "team" && parts[2] === "tasks" && parts[3]) {
    return json(res, await services.deleteTeamTask(Number(parts[3])));
  }

  return false;
}
