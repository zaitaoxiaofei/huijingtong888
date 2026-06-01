import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.resolve(rootDir, "public");
const version = process.env.OZON_RELEASE_VERSION || process.env.APP_RELEASE_VERSION || "local";
const channel = process.env.OZON_RELEASE_CHANNEL || "local";
const buildStamp = process.env.OZON_BUILD_STAMP || "";

const release = {
  app: "ozon-erp",
  version,
  channel,
  build_stamp: buildStamp,
  built_at: new Date().toISOString()
};

await fs.mkdir(publicDir, { recursive: true });
await fs.writeFile(
  path.resolve(publicDir, "release.json"),
  `${JSON.stringify(release, null, 2)}\n`,
  "utf8"
);

console.log(`Wrote frontend release metadata: ${version}`);
