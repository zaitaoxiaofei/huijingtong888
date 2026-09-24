import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function setup({ blocked = false } = {}) {
  const nodes = Object.fromEntries(["close", "print", "pdf", "status", "barcode"].map((id) => [id, { disabled: true }]));
  let prints = 0;
  let confirmations = 0;
  let revoked = 0;
  let cleared = 0;
  let poll;
  nodes.barcode.contentWindow = { focus() {}, print() { prints++; } };
  const preview = { closed: false, close() { this.closed = true; }, document: {
    write() {}, close() {}, getElementById(id) { return nodes[id]; }
  } };
  const context = vm.createContext({
    window: { open: () => blocked ? null : preview, setInterval(fn) { poll = fn; return 1; }, clearInterval() { cleared++; } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() { revoked++; } }
  });
  vm.runInContext(readFileSync(new URL("../frontend/admin/utils/barcode-print-window.js", import.meta.url), "utf8").replace("export function", "function"), context);
  return { open: () => context.openBarcodePrintWindow(), nodes, preview, poll: () => poll(),
    onPrint: () => confirmations++, counts: () => ({ prints, confirmations, revoked, cleared }) };
}

test("slow PDF loading and asynchronous print keep their source alive until the preview closes", () => {
  const env = setup();
  env.open().show({}, env.onPrint);
  for (let i = 0; i < 200; i++) env.poll();
  assert.equal(env.nodes.print.disabled, true);
  assert.equal(env.counts().revoked, 0);
  env.nodes.barcode.onload();
  assert.equal(env.nodes.print.disabled, false);
  assert.equal(env.counts().prints, 0);
  env.nodes.print.onclick();
  for (let i = 0; i < 200; i++) env.poll();
  assert.deepEqual(env.counts(), { prints: 1, confirmations: 1, revoked: 0, cleared: 0 });
  env.nodes.print.onclick();
  assert.equal(env.counts().prints, 2);
  env.nodes.close.onclick();
  env.poll();
  assert.equal(env.counts().revoked, 1);
  assert.equal(env.counts().cleared, 1);
});

test("blocked or closed previews report an actionable error without allocating a PDF URL", () => {
  assert.throws(() => setup({ blocked: true }).open(), /允许本站打开弹窗/);
  const env = setup();
  const controller = env.open();
  env.preview.close();
  assert.throws(() => controller.show({}, env.onPrint), /预览已关闭/);
  env.poll();
  assert.equal(env.counts().revoked, 0);
});

test("generation and print errors leave a readable preview and manual PDF fallback", () => {
  const env = setup();
  const controller = env.open();
  controller.showError("生成失败");
  assert.equal(env.nodes.status.textContent, "生成失败");
  controller.show({}, env.onPrint);
  env.nodes.barcode.contentWindow.print = () => { throw new Error("PDF viewer unavailable"); };
  env.nodes.print.onclick();
  assert.match(env.nodes.status.textContent, /打开 PDF/);
  assert.equal(env.counts().confirmations, 0);
  assert.equal(env.nodes.pdf.href, "blob:test");
  env.nodes.pdf.onclick();
  assert.equal(env.counts().confirmations, 1);
  assert.equal(env.counts().revoked, 0);
});
