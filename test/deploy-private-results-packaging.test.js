import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeployCopyFilter } from "../scripts/lib/deploy-copy-filter.mjs";

async function fixture(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-deploy-private-"));
  try {
    const root = path.join(directory, "source"), output = path.join(directory, "release");
    await fs.mkdir(path.join(root, "data"), { recursive: true });
    await fs.writeFile(path.join(root, "data", "public-seed.json"), "{}");
    await action({ directory, root, output });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const missing = async file => assert.equal(await fs.lstat(file).then(() => false, error => error.code === "ENOENT"), true, `${file} must not exist, even as a symlink`);

test("private retention manifests and their public aliases never enter deployment archives", () => fixture(async ({ root, output }) => {
  const privateDirectory=path.join(root,'data','ai-media-retention');
  await fs.mkdir(privateDirectory);await fs.writeFile(path.join(privateDirectory,'plan.json'),'{"private_business_urls":true}');
  await fs.mkdir(path.join(root,'public'));
  await fs.symlink(privateDirectory,path.join(root,'public','retention-alias'),process.platform==='win32'?'junction':'dir');
  await fs.cp(root,output,{recursive:true,filter:createDeployCopyFilter(root,{includeUploads:true})});
  await missing(path.join(output,'data','ai-media-retention'));await missing(path.join(output,'public','retention-alias'));
  assert.equal(await fs.readFile(path.join(privateDirectory,'plan.json'),'utf8'),'{"private_business_urls":true}');
}));

test("real fs.cp excludes private result directories but preserves release seed data", () => fixture(async ({ root, output }) => {
  await fs.mkdir(path.join(root, "data", "ai-credit-results", "2"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "ai-credit-results", "2", "private.json"), "private");
  await fs.mkdir(path.join(root, "data", "ai-credit-results-template"));
  await fs.writeFile(path.join(root, "data", "ai-credit-results-template", "schema.json"), "{}");
  await fs.cp(root, output, { recursive: true, filter: createDeployCopyFilter(root) });
  await missing(path.join(output, "data", "ai-credit-results"));
  assert.equal(await fs.readFile(path.join(output, "data", "public-seed.json"), "utf8"), "{}");
  assert.equal(await fs.readFile(path.join(output, "data", "ai-credit-results-template", "schema.json"), "utf8"), "{}");
}));

test("private result symlink/junction is neither followed nor preserved in a release", () => fixture(async ({ directory, root, output }) => {
  const secret = path.join(directory, "shared-private-ai-results");
  await fs.mkdir(secret); await fs.writeFile(path.join(secret, "private.json"), "private");
  await fs.symlink(secret, path.join(root, "data", "ai-credit-results"), process.platform === "win32" ? "junction" : "dir");
  await fs.cp(root, output, { recursive: true, filter: createDeployCopyFilter(root, { includeUploads: true }) });
  await missing(path.join(output, "data", "ai-credit-results"));
  assert.equal(await fs.readFile(path.join(secret, "private.json"), "utf8"), "private");
  assert.equal(await fs.readFile(path.join(output, "data", "public-seed.json"), "utf8"), "{}");
}));

test("public-upload opt-in cannot include private results; configured private roots are also excluded", () => fixture(async ({ root, output }) => {
  for (const folder of ["data/ai-credit-results", "data/custom-private", "public/uploads"]) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, folder, "content.json"), "{}");
  }
  await fs.cp(root, output, { recursive: true, filter: createDeployCopyFilter(root, { includeUploads: true, privateResultRoot: "data/custom-private" }) });
  await missing(path.join(output, "data", "ai-credit-results"));
  await missing(path.join(output, "data", "custom-private"));
  assert.equal(await fs.readFile(path.join(output, "public", "uploads", "content.json"), "utf8"), "{}");
  const noUploads = path.join(path.dirname(output), "release-no-uploads");
  await fs.cp(root, noUploads, { recursive: true, filter: createDeployCopyFilter(root) });
  await missing(path.join(noUploads, "public", "uploads"));
}));

test("real fs.cp excludes public aliases to a private directory or its ancestor", () => fixture(async ({ root, output }) => {
  const secret=path.join(root,"data","ai-credit-results","2");
  await fs.mkdir(secret,{recursive:true});await fs.writeFile(path.join(secret,"private.json"),"private");
  await fs.mkdir(path.join(root,"public"));
  for(const [name,target] of [["alias",secret],["data-alias",path.join(root,"data")]]){
    await fs.symlink(target,path.join(root,"public",name),process.platform==="win32"?"junction":"dir");
  }
  const filter=createDeployCopyFilter(root,{includeUploads:true});
  await fs.cp(root,output,{recursive:true,filter});
  await missing(path.join(output,"public","alias"));await missing(path.join(output,"public","data-alias"));
  assert.equal(await fs.readFile(path.join(output,"data","public-seed.json"),"utf8"),"{}");
  assert.equal(await fs.readFile(path.join(secret,"private.json"),"utf8"),"private");
  // Unrelated links are not globally forbidden. Added after the first copy to
  // also exercise the bounded lstat fallback for a cached-directory miss.
  const ordinary=path.join(root,"public","ordinary-alias");
  await fs.mkdir(path.join(root,"static"));
  await fs.symlink(path.join(root,"static"),ordinary,process.platform==="win32"?"junction":"dir");
  assert.equal(await filter(ordinary),true);
}));

test("real fs.cp excludes aliases to the real target of a configured private-root junction", () => fixture(async ({ directory,root,output }) => {
  const external=path.join(directory,"external-private"),configured=path.join(root,"data","custom-private");
  await fs.mkdir(path.join(external,"2"),{recursive:true});await fs.writeFile(path.join(external,"2","private.json"),"private");
  await fs.symlink(external,configured,process.platform==="win32"?"junction":"dir");
  await fs.mkdir(path.join(root,"public"));
  const filter=createDeployCopyFilter(root,{includeUploads:true,privateResultRoot:"data/custom-private"});
  await fs.writeFile(path.join(root,"public","seed.json"),"{}");
  await filter(path.join(root,"public","seed.json")); // Cache before a new alias appears.
  await fs.symlink(path.join(external,"2"),path.join(root,"public","late-alias"),process.platform==="win32"?"junction":"dir");
  await fs.cp(root,output,{recursive:true,filter});
  await missing(path.join(output,"public","late-alias"));await missing(path.join(output,"data","custom-private"));
  assert.equal(await fs.readFile(path.join(output,"data","public-seed.json"),"utf8"),"{}");
  assert.equal(await fs.readFile(path.join(external,"2","private.json"),"utf8"),"private");
}));

test("production packaging uses the guarded filter for every copied entry", async () => {
  const source = await fs.readFile(new URL("../scripts/package-deploy.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ createDeployCopyFilter \} from "\.\/lib\/deploy-copy-filter\.mjs"/);
  assert.match(source, /filter: deployCopyFilter/);
  assert.doesNotMatch(source, /filter: relativePath === "public"/);
});
