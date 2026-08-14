import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const client = fs.readFileSync(new URL("../deploy/linux/deploy-ecs.ps1", import.meta.url), "utf8");
const remote = fs.readFileSync(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8");
const oneClick = fs.readFileSync(new URL("../deploy/linux/deploy-ecs-one-click.ps1", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("../一键部署到阿里云.vbs", import.meta.url), "utf8");
const keySetup = fs.readFileSync(new URL("../deploy/linux/configure-ecs-key.ps1", import.meta.url), "utf8");

test("ECS deployment uploads one artifact and delegates atomic release activation", () => {
  assert.match(client, /npm\.cmd run package:deploy/);
  assert.match(client, /scp @scpOptions/);
  assert.match(client, /bash '\$remoteScript'/);
  assert.match(remote, /previous_target="\$\(readlink -f/);
  assert.match(remote, /ln -sfn "\$release_dir" "\$current_link"/);
  assert.match(remote, /Release failed; attempting rollback/);
});

test("ECS deployment preserves server secrets and shared uploads", () => {
  assert.match(remote, /env_file="\/etc\/ozon-erp\/ozon-erp\.env"/);
  assert.match(remote, /shared_root\/uploads\/public/);
  assert.match(remote, /shared_root\/uploads\/runtime/);
  assert.doesNotMatch(client, /ACCESS_KEY|DB_PASSWORD|OSS_ACCESS/);
});

test("ECS deployment validates the service before accepting the release", () => {
  assert.match(remote, /systemctl restart ozon-erp/);
  assert.match(remote, /http:\/\/127\.0\.0\.1:3000\//);
  assert.match(remote, /status" == "200" \|\| "\$status" == "401"/);
});

test("one-click launcher runs deployment hidden and keeps a durable log", () => {
  assert.match(launcher, /WindowStyle Hidden/);
  assert.match(launcher, /deploy-ecs-one-click\.ps1/);
  assert.match(oneClick, /deploy-ecs\.ps1/);
  assert.match(oneClick, /one-click-deploy\.log/);
  assert.match(oneClick, /MessageBox/);
});

test("first-time setup stores only a local key path and verifies passwordless SSH", () => {
  assert.match(keySetup, /OpenFileDialog/);
  assert.match(keySetup, /ozon-erp-deploy\.pem/);
  assert.match(keySetup, /ecs-deploy\.json/);
  assert.match(keySetup, /BatchMode=yes/);
  assert.doesNotMatch(keySetup, /AccessKey|DB_PASSWORD|OSS_ACCESS/);
});
