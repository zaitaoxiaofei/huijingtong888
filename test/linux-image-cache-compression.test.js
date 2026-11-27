import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const remote = (await fs.readFile(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const policy = await fs.readFile(new URL("../deploy/linux/nginx-response-compression.conf", import.meta.url), "utf8");
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git/bin/bash.exe") : "bash";
const skip = process.platform === "win32" && !existsSync(bash);
const functionSource = name => {
  const found = remote.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"));
  assert.ok(found, name);
  return found[0];
};
const posix = value => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

async function fixture(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-proxy-cost-"));
  try {
    const configRoot = path.join(directory, "nginx");
    await fs.mkdir(path.join(configRoot, "sites-enabled"), { recursive: true });
    await fs.mkdir(path.join(directory, "deploy/linux"), { recursive: true });
    await fs.writeFile(path.join(directory, "deploy/linux/nginx-response-compression.conf"), policy);
    const config = "server {\n    listen 443 ssl;\n    ssl_certificate /unchanged/cert.pem;\n    location / {\n        proxy_pass http://ozon_erp_backend;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}\n";
    await fs.writeFile(path.join(configRoot, "sites-enabled/erp"), config);
    const run = (script = "", fail = "") => execute(bash, ["--noprofile", "--norc", "-c", `
set -Eeuo pipefail
release_dir="$PWD"
shared_root="$PWD/shared"
staging_dir="$PWD/staging"
trace() { printf '%s\\n' "$*" >> "$PWD/trace"; }
nginx() { trace nginx-test; [[ '${fail}' != syntax ]]; }
systemctl() { trace "$*"; if [[ '${fail}' == reload && ! -e "$PWD/reload-failed" ]]; then touch "$PWD/reload-failed"; return 1; fi; }
install() { local -a kept=(); while (($#)); do if [[ "$1" == -o || "$1" == -g || ( "$1" == -m && '${process.platform}' == win32 ) ]]; then shift 2; else kept+=("$1"); shift; fi; done; command install "${'${kept[@]}'}"; }
${process.platform === "win32" ? "ln() { node -e 'require(\"fs\").symlinkSync(process.argv[1],process.argv[2],\"junction\")' \"$(cygpath -w \"$2\")\" \"$(cygpath -w \"$3\")\"; }" : ""}
${functionSource("configure_nginx_response_compression").replaceAll("/etc/nginx", posix(configRoot))}
${functionSource("prepare_image_read_caches")}
${script}
`], { cwd: directory, env: { ...process.env, BASH_ENV: "" } });
    await action({ directory, configRoot, config, run });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("Nginx response compression updates only ERP proxy locations and is idempotent", { skip }, async () => fixture(async ({ directory, configRoot, config, run }) => {
  const unrelated = "server { location / { proxy_pass http://other_backend; } }\n";
  await fs.writeFile(path.join(configRoot, "sites-enabled/other"), unrelated);
  await run("configure_nginx_response_compression\nconfigure_nginx_response_compression");
  const updated = await fs.readFile(path.join(configRoot, "sites-enabled/erp"), "utf8");
  assert.match(updated, /include .*\/snippets\/ozon-erp-response-compression\.conf;/);
  assert.equal(updated.replace(/^.*include .*ozon-erp-response-compression\.conf;\n/m, ""), config);
  assert.equal(await fs.readFile(path.join(configRoot, "sites-enabled/other"), "utf8"), unrelated);
  assert.equal(await fs.readFile(path.join(configRoot, "snippets/ozon-erp-response-compression.conf"), "utf8"), policy);
  assert.deepEqual((await fs.readFile(path.join(directory, "trace"), "utf8")).trim().split(/\r?\n/), ["nginx-test", "reload nginx"]);
  assert.equal((await fs.readdir(configRoot)).some(name => name.startsWith(".ozon-response")), false);
}));

for (const fail of ["syntax", "reload"]) {
  test(`Nginx ${fail} failure restores both the prior site and prior compression policy`, { skip }, async () => fixture(async ({ directory, configRoot, config, run }) => {
    await fs.mkdir(path.join(configRoot, "snippets"));
    const previous = "# previous reviewed policy\ngzip_types application/json;\n";
    await fs.writeFile(path.join(configRoot, "snippets/ozon-erp-response-compression.conf"), previous);
    await assert.rejects(run("configure_nginx_response_compression", fail), error => /previous Nginx files restored/.test(error.stderr));
    assert.equal(await fs.readFile(path.join(configRoot, "sites-enabled/erp"), "utf8"), config);
    assert.equal(await fs.readFile(path.join(configRoot, "snippets/ozon-erp-response-compression.conf"), "utf8"), previous);
    const trace = (await fs.readFile(path.join(directory, "trace"), "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(trace, fail === "syntax" ? ["nginx-test"] : ["nginx-test", "reload nginx", "nginx-test", "reload nginx"]);
  }));
}

test("a failed first compression installation removes its new policy without leaving a broken include", { skip }, async () => fixture(async ({ configRoot, config, run }) => {
  await assert.rejects(run("configure_nginx_response_compression", "syntax"));
  assert.equal(await fs.readFile(path.join(configRoot, "sites-enabled/erp"), "utf8"), config);
  await assert.rejects(fs.access(path.join(configRoot, "snippets/ozon-erp-response-compression.conf")), error => error.code === "ENOENT");
}));

test("two releases share only the dedicated private image read caches", { skip }, async () => fixture(async ({ directory, run }) => {
  await run("mkdir staging\nprepare_image_read_caches");
  const first = path.join(directory, "staging/runtime/image-proxy-cache");
  await fs.writeFile(path.join(first, `${"a".repeat(64)}.bin`), "retained cache");
  await fs.rename(path.join(directory, "staging"), path.join(directory, "previous"));
  await run("mkdir staging\nprepare_image_read_caches");
  const second = path.join(directory, "staging/runtime/image-proxy-cache");
  assert.equal(await fs.realpath(first.replace("staging", "previous")), await fs.realpath(second));
  assert.equal(await fs.readFile(path.join(second, `${"a".repeat(64)}.bin`), "utf8"), "retained cache");
  assert.deepEqual((await fs.readdir(path.join(directory, "shared"))).sort(), ["image-read-cache"]);
}));

test("cache setup refuses packaged cache contents without deleting them", { skip }, async () => fixture(async ({ directory, run }) => {
  await fs.mkdir(path.join(directory, "staging/runtime/image-proxy-cache"), { recursive: true });
  await fs.writeFile(path.join(directory, "staging/runtime/image-proxy-cache/keep"), "retained");
  await assert.rejects(run("prepare_image_read_caches"), error => /archives must not contain runtime image caches/.test(error.stderr));
  assert.equal(await fs.readFile(path.join(directory, "staging/runtime/image-proxy-cache/keep"), "utf8"), "retained");
}));

test("the compression policy leaves images, event streams and API caching contracts alone", () => {
  assert.match(policy, /gzip_vary on;/);
  assert.match(policy, /gzip_types[^;]*application\/json/);
  assert.doesNotMatch(policy, /image\/(?:png|jpeg|webp)|text\/event-stream|proxy_cache|Cache-Control/);
  assert.ok(remote.indexOf("\nconfigure_nginx_response_compression\n") < remote.indexOf("\nconfigure_nginx_failover\n"));
  assert.ok(remote.indexOf("\nprepare_image_read_caches\n") < remote.indexOf("\nstart_candidate\n"));
});
