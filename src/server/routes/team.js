export function createTeamRoutes({ services, readJson }) {
  return {
    "GET /api/team/operational-owners": () => services.teamOperationalOwners(),
    "PUT /api/team/operational-owners": async (req) => services.setTeamOperationalOwner(await readJson(req)),
    "GET /api/team/tasks": (req, url) => services.teamTasks(Object.fromEntries(url.searchParams.entries())),
    "GET /api/team/development-projects": () => services.developmentProjects(),
    "GET /api/team/development-candidates": (req, url) => services.developmentCandidates(Object.fromEntries(url.searchParams.entries())),
    "GET /api/team/development-ideas": () => services.developmentIdeas(),
    "GET /api/team/development-categories": () => services.developmentInventoryCategories(),
    "POST /api/team/attachments": (req) => services.uploadTeamAttachment(req),
    "POST /api/team/tasks": async (req) => services.createTeamTask(await readJson(req), req._session?.personId),
    "POST /api/team/development-projects": async (req) => services.createDevelopmentProject(await readJson(req), req._session?.personId),
    "POST /api/team/development-candidates": async (req) => services.createDevelopmentCandidate(await readJson(req), req._session?.personId),
    "POST /api/team/development-ideas": async (req) => services.createDevelopmentIdea(await readJson(req), req._session?.personId)
  };
}

export async function handleTeamRestRoute({ req, res, parts, services, readJson, json }) {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "team" && parts[2] === "tasks" && parts[3] && parts[4] === "operational-details") {
    return json(res, await services.teamTaskOperationalDetails(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "team" && parts[2] === "tasks" && parts[3]) {
    return json(res, await services.updateTeamTask(Number(parts[3]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "team" && parts[2] === "tasks" && parts[3]) {
    return json(res, await services.deleteTeamTask(Number(parts[3])));
  }

  if (parts[0] === "api" && parts[1] === "team" && parts[2] === "development-projects" && parts[3]) {
    if (req.method === "PUT") return json(res, await services.updateDevelopmentProject(Number(parts[3]), await readJson(req)));
    if (req.method === "DELETE") return json(res, await services.deleteDevelopmentProject(Number(parts[3])));
  }

  if (parts[0] === "api" && parts[1] === "team" && parts[2] === "development-candidates" && parts[3]) {
    if (req.method === "PUT") return json(res, await services.updateDevelopmentCandidate(Number(parts[3]), await readJson(req)));
    if (req.method === "DELETE") return json(res, await services.deleteDevelopmentCandidate(Number(parts[3])));
  }

  if (parts[0] === "api" && parts[1] === "team" && parts[2] === "development-ideas" && parts[3]) {
    if (req.method === "POST" && parts[4] === "link-product") return json(res, await services.linkDevelopmentIdea(Number(parts[3]), await readJson(req), req._session?.personId));
    if (req.method === "POST" && parts[4] === "link-draft") return json(res, await services.linkDevelopmentIdeaDraft(Number(parts[3]), await readJson(req)));
    if (req.method === "POST" && parts[4] === "start-development") return json(res, await services.startDevelopmentIdea(Number(parts[3])));
    if (req.method === "POST" && parts[4] === "claim") return json(res, await services.claimDevelopmentIdea(Number(parts[3]), req._session?.personId));
    if (req.method === "PUT") return json(res, await services.updateDevelopmentIdea(Number(parts[3]), await readJson(req)));
    if (req.method === "DELETE") return json(res, await services.deleteDevelopmentIdea(Number(parts[3])));
  }

  return false;
}
