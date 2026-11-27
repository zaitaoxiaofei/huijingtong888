import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { sendPublicImageThumbnail } from "../src/server/routes/imageThumbnail.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { isPrivateImageRead, readCookie, tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { isTenantPilotRoute } from "../src/server/tenant-pilot-routes.js";
import { subscriptionAccessDecision } from "../src/server/subscription-access.js";
import { json, notFound } from "../src/http/response.js";
import path from "node:path";
import os from "node:os";
import { createPublicImageThumbnailService } from "../src/services/public-image-thumbnail.js";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const implementation = source.slice(source.indexOf("const server = http.createServer("), source.indexOf("async function prepareRuntimeBeforeListen("));
const queryAuth = source.match(/^function allowQueryTokenAuth\([^]*?^}/m)?.[0];
const target = `https://bucket.example/listing-media/aa/${"a".repeat(64)}.png`;
const requestUrl = `/api/image-thumbnail?${new URLSearchParams({ url: target, w: "180" })}`;
const member = id => ({ personId: id, roles: ["operations"], tenant: { id, slug: `tenant-${id}`, role: "member", access_allowed: true } });

function fixture({ siteAccess = true, failure = null, reader = null } = {}) {
  const reads = [], sessionTokens = [];
  const sessions = new Map([["alpha", member(21)], ["beta", member(22)],
    ["expired", { ...member(23), tenant: { ...member(23).tenant, access_allowed: false } }],
    ["platform", { personId: 99, platform_role: "super_admin" }]]);
  let handle;
  const context = vm.createContext({
    URL, Buffer, AbortController, performance,
    console: { error() {}, warn() {} },
    http: { createServer(handler) { handle = handler; return {}; } },
    protectMediaRequest: async () => {}, trackForegroundApiRequest() {}, logSlowApiRequest() {}, markRequestTiming() {},
    handleLocalPluginRoute: async () => false, isPublicListingMediaPath: () => false, isVersionedVueAssetPath: () => false, isPrivateAttachmentPath: () => false,
    publicSelfServiceEnabled: () => false, publicWebsitePath: () => false, isPublicEntry: () => false,
    isSiteAccessAuthorized: () => siteAccess, isPublicAuthCallbackPath: () => false,
    SITE_ACCESS_SESSION_PATH: "/site-access/session", SITE_ACCESS_LOGIN_PATH: "/site-access/login",
    SITE_ACCESS_LOGOUT_PATH: "/site-access/logout", SITE_ACCESS_API_LOGIN_PATH: "/site-access/api/login",
    IMAGE_SESSION_COOKIE: "erp_image_session", isPrivateImageRead, readCookie,
    extractToken: req => /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "",
    getSession: async token => { sessionTokens.push(token); return sessions.get(token) || null; },
    tenantIsolationDecision, authorizeApiRequest, subscriptionAccessDecision,
    sendPublicImageThumbnail: (req, res, url) => sendPublicImageThumbnail(req, res, url, { read: async (value, options) => {
      reads.push({ value, options, tenantId: req._session?.tenant?.id });
      if (failure) throw failure;
      if (reader) return reader(value, options);
      return { buffer: Buffer.from("bounded-webp"), contentType: "image/webp", cacheControl: "public, max-age=86400", cacheState: "HIT" };
    } }),
    handleRestRoute: async () => false, routes: {}, serveStatic: (_path, _req, res) => notFound(res),
    json, notFound, isRequestCancelledError: () => false
  });
  vm.runInContext(queryAuth + "\n" + implementation, context);
  return { reads, sessionTokens, async run({ path = requestUrl, method = "GET", token = "", cookie = "", headers = {} } = {}) {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "erp.fixture", ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) } });
    const res = Object.assign(new EventEmitter(), { statusCode: 0, headers: {}, writableEnded: false, destroyed: false,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, values) { this.statusCode = status; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); },
      end(body) { this.body = Buffer.from(body || ""); this.writableEnded = true; this.emit("finish"); }
    });
    await handle(req, res); return res;
  } };
}

test("the actual server checks session, tenant and subscription before deriving list images", async () => {
  for (const [token, status] of [["", 401], ["platform", 403], ["expired", 402]]) {
    const f = fixture(), response = await f.run({ token });
    assert.equal(response.statusCode, status, response.body.toString()); assert.equal(f.reads.length, 0);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const blocked = fixture({ siteAccess: false }), response = await blocked.run({ token: "alpha" });
  assert.equal(response.statusCode, 403); assert.equal(blocked.reads.length, 0);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("authorized alpha/beta sessions get only the same bounded public derivative with safe headers", async () => {
  const f = fixture();
  for (const token of ["alpha", "beta"]) {
    const response = await f.run({ token });
    assert.equal(response.statusCode, 200, response.body.toString()); assert.equal(response.headers["content-type"], "image/webp");
    assert.equal(response.headers["content-length"], response.body.length);
    assert.equal(response.headers["cache-control"], "public, max-age=86400");
    assert.equal(response.headers["x-image-thumbnail-cache"], "HIT");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(response.headers["content-security-policy"], /default-src 'none'.*sandbox/);
    assert.equal(response.headers["set-cookie"], undefined);
  }
  assert.deepEqual(f.reads.map(value => value.tenantId), [21, 22]);
  assert.ok(f.reads.every(value => value.value === target && value.options.width === 180));
});

test("native-image cookie auth stays on the exact GET route; query credentials and anonymous requests never invoke the reader", async () => {
  const f = fixture();
  assert.equal((await f.run({ cookie: "other=ignored; erp_image_session=alpha" })).statusCode, 200);
  assert.equal(f.reads.length, 1);
  const query = await f.run({ path: requestUrl + "&token=alpha" });
  assert.equal(query.statusCode, 401); assert.equal(f.reads.length, 1);
  assert.equal((await f.run({ cookie: "erp_image_session=expired-token" })).statusCode, 401);
  assert.equal(f.reads.length, 1);
  for (const [path, method] of [["/api/image-thumbnail/extra", "GET"], ["/api/image-thumbnail/", "GET"],
    ["/api/image-thumbnail%2fprivate", "GET"], ["/api/image-thumbnail-other", "GET"], ["/image-thumbnail", "GET"],
    ["/api/image-thumbnail", "POST"], ["/api/image-thumbnail", "HEAD"], ["/api/image-thumbnail", "OPTIONS"]]) {
    const response = await f.run({ path, method, cookie: "erp_image_session=alpha" });
    assert.notEqual(response.statusCode, 200, `${method} ${path}`); assert.equal(f.reads.length, 1);
  }
});

test("pilot and business authorization whitelist only the collection GET and preserve enterprise context", () => {
  assert.equal(isTenantPilotRoute("image-thumbnail", "GET"), true);
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    assert.equal(isTenantPilotRoute("image-thumbnail", method), false);
    assert.equal(tenantIsolationDecision(member(21), ["api", "image-thumbnail"], method).allowed, false);
  }
  assert.equal(tenantIsolationDecision({}, ["api", "image-thumbnail"], "GET").allowed, false);
  for (const path of ["image-thumbnail/extra", "image-thumbnail-other"]) {
    assert.equal(isTenantPilotRoute(path, "GET"), false);
    assert.equal(authorizeApiRequest({ method: "GET", _session: member(21) }, ["api", ...path.split("/")]).allowed, false);
  }
});

test("rejected private/source requests produce no-store errors and explicit reload bypasses a bad derivative cache", async () => {
  const rejected = fixture({ failure: Object.assign(new Error("not a public image"), { statusCode: 400 }) });
  const response = await rejected.run({ token: "alpha" });
  assert.equal(response.statusCode, 400); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["set-cookie"], undefined);
  const f = fixture();
  await f.run({ token: "alpha", headers: { "cache-control": "no-cache" } });
  assert.equal(f.reads[0].options.force, true);
});

test("valid sessions from either enterprise cannot turn a private OSS URL into a public derivative", async () => {
  let privilegedReads = 0;
  const env = { OSS_ENABLED: "true", OSS_INTERNAL_READ: "true", OSS_BUCKET: "fixture-private-rejection", OSS_REGION: "oss-cn-heyuan", OSS_ACCESS_KEY_ID: "fixture", OSS_ACCESS_KEY_SECRET: "fixture" };
  const service = createPublicImageThumbnailService({ env, cacheDirectory: path.join(os.tmpdir(), "thumbnail-invalid-target-no-cache"),
    readSource: async () => { privilegedReads++; throw Error("Private SDK access must never happen"); } });
  const f = fixture({ reader: (target, options) => service.get(target, options) });
  for (const token of ["alpha", "beta"]) {
    for (const prefix of ["ai-task-media", "team-attachments", "database-archives"]) {
      const url = `https://fixture-private-rejection.oss-cn-heyuan.aliyuncs.com/${prefix}/aa/${"a".repeat(64)}.png`;
      const response = await f.run({ token, path: "/api/image-thumbnail?" + new URLSearchParams({ url, tenant_id: "999" }) });
      assert.equal(response.statusCode, 400); assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["set-cookie"], undefined);
    }
  }
  assert.equal(privilegedReads, 0);
});
