import { listOnboardingArticles, onboardingArticleHistory, saveOnboardingArticle } from "../../services/onboarding-knowledge.js";

export function createOnboardingKnowledgeRoutes({ readJson }) {
  return {
    "GET /api/onboarding/articles": (req) => listOnboardingArticles(req.query || {}, req._session || {}),
    "POST /api/onboarding/articles": async (req) => saveOnboardingArticle(await readJson(req), req._session || {})
  };
}

export async function handleOnboardingKnowledgeRestRoute({ req, res, parts, json, notFound }) {
  if (parts[0] !== "api" || parts[1] !== "onboarding" || parts[2] !== "articles") return false;
  if (req.method === "GET" && parts[3] && parts[4] === "history") {
    const id = Number(parts[3]);
    if (!id) return notFound(res);
    return json(res, await onboardingArticleHistory(id));
  }
  return false;
}
