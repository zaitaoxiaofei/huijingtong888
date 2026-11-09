import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

test("release branch provenance cannot create nested asset paths or URL fragments", async () => {
  const previous = process.env.OZON_BUILD_STAMP;
  try {
    process.env.OZON_BUILD_STAMP = "release/hotfix@abc123?x#y\\z";
    const { default: config } = await import(`../vite.config.js?stamp-test=${Date.now()}`);
    const output = config.build.rollupOptions.output;
    for (const key of ["entryFileNames", "chunkFileNames", "assetFileNames"]) {
      assert.equal(output[key].split("/").length, 2);
      assert.ok(output[key].includes("[hash]"));
      assert.doesNotMatch(output[key], /hotfix|abc123|stamp/);
      assert.doesNotMatch(output[key], /[@?#\\]/);
    }
  } finally {
    if (previous === undefined) delete process.env.OZON_BUILD_STAMP;
    else process.env.OZON_BUILD_STAMP = previous;
  }
});

test("HTML carries the actual release version safely while bundle definitions remain stable", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'release-html-'));
  try {
    await fs.mkdir(path.join(root,'public'));
    const manifest=path.join(root,'manifest.json');
    await fs.writeFile(manifest,JSON.stringify({'frontend/admin/main.js':{file:'assets/admin-content.js',imports:[],css:[]}}));
    const version='release</script><script>injected()</script>';
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/generate-admin-shell.mjs',import.meta.url))],{
      cwd:root,env:{...process.env,OZON_VITE_MANIFEST_PATH:manifest,OZON_RELEASE_VERSION:version,OZON_RELEASE_CHANNEL:'production'}
    });
    const html=await fs.readFile(path.join(root,'public/admin.html'),'utf8');
    const script=html.match(/<script>(globalThis\.__ERP_RELEASE_METADATA__ = .*?;)<\/script>/)?.[1];assert.ok(script);
    assert(!script.includes('</script>'));
    const context={};runInNewContext(script,context);
    assert.equal(context.__ERP_RELEASE_METADATA__.version,version);
    const config=(await import('../vite.config.js?runtime-metadata-test')).default;
    assert.equal(runInNewContext(config.define.__APP_RELEASE_VERSION__,context),version);
    assert.equal(runInNewContext(config.define.__APP_RELEASE_CHANNEL__,context),'production');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("build timestamps do not rename unchanged frontend assets", async () => {
  const previous=process.env.OZON_BUILD_STAMP;
  try {
    process.env.OZON_BUILD_STAMP="one";
    const first=(await import('../vite.config.js?cache-test=one')).default.build.rollupOptions.output;
    process.env.OZON_BUILD_STAMP="two";
    const second=(await import('../vite.config.js?cache-test=two')).default.build.rollupOptions.output;
    for(const key of ['entryFileNames','chunkFileNames','assetFileNames']) assert.equal(first[key],second[key]);
  } finally { if(previous===undefined)delete process.env.OZON_BUILD_STAMP;else process.env.OZON_BUILD_STAMP=previous; }
});
