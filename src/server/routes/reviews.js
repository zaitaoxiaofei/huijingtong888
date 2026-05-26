export function createReviewRoutes({ services, readJson }) {
  return {
    "GET /api/reviews": (req, url) => services.reviewCenter(Object.fromEntries(url.searchParams.entries())),
    "POST /api/reviews/sync": async (req) => services.syncOzonReviews(await readJson(req), { signal: req._abortSignal }),
    "GET /api/review-reply-templates": () => services.reviewReplyTemplates()
  };
}

export async function handleReviewRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "reply") {
    return json(res, await services.replyOzonReview(Number(parts[2]), await readJson(req), req._session?.personId));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "comments") {
    const comments = await services.reviewComments(Number(parts[2]));
    return comments ? json(res, comments) : notFound(res);
  }

  return false;
}
