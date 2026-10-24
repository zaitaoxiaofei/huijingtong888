import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import ExcelJS from "exceljs";
import sharp from "sharp";
import OSS from "ali-oss";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";

const require = createRequire(import.meta.url);

test("security updates preserve the protected Excel, image and OSS release lines", () => {
  assert.equal(require("exceljs/package.json").version, "4.4.0");
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(Number(require("ali-oss/package.json").version.split(".")[0]), 6);
  assert.equal(require("mysql2/package.json").version, "3.23.1");
});

test("Sharp still creates and transforms PNG bytes after dependency installation", async () => {
  const png = await sharp({ create: { width: 32, height: 48, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } } }).png().toBuffer();
  const jpeg = await sharp(png).resize(16, 24).jpeg().toBuffer();
  const metadata = await sharp(jpeg).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.format], [16, 24, "jpeg"]);
});

test("ExcelJS round-trips Chinese business fields, money, formulae and an embedded image", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("采购核对");
  sheet.addRow(["商品", "数量", "单价", "金额", "备注"]);
  sheet.addRow(["车型配件 八件套", 5, 12.34, { formula: "B2*C2", result: 61.7 }, "企业内共享库存"]);
  sheet.getCell("C2").numFmt = "0.00";
  sheet.getCell("D2").numFmt = "0.00";
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#102030" } }).png().toBuffer();
  const imageId = workbook.addImage({ buffer: image, extension: "png" });
  sheet.addImage(imageId, "A4:B8");
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const restored = loaded.getWorksheet("采购核对");
  assert.equal(restored.getCell("A2").value, "车型配件 八件套");
  assert.equal(restored.getCell("B2").value, 5);
  assert.equal(restored.getCell("C2").value, 12.34);
  assert.deepEqual(restored.getCell("D2").value, { formula: "B2*C2", result: 61.7 });
  assert.equal(restored.getCell("E2").value, "企业内共享库存");
  assert.equal(restored.getImages().length, 1);
  assert.equal(loaded.getImage(restored.getImages()[0].imageId).extension, "png");
});

test("OSS SDK signs Unicode object downloads without making a remote request", () => {
  const client = new OSS({ accessKeyId: "isolated-fixture", accessKeySecret: "not-a-real-secret", bucket: "isolated-fixture", region: "oss-cn-hangzhou", secure: true });
  const signed = new URL(client.signatureUrl("fixture/商品 主图.png", { expires: 60, response: { "content-disposition": "attachment; filename=product.png" } }));
  assert.equal(signed.protocol, "https:");
  assert.equal(decodeURIComponent(signed.pathname), "/fixture/商品 主图.png");
  assert.equal(signed.searchParams.get("response-content-disposition"), "attachment; filename=product.png");
  assert.equal(signed.searchParams.get("OSSAccessKeyId"), "isolated-fixture");
  assert.ok(signed.searchParams.get("Signature"));
});

test("patched Vue SSR rejects carriage-return attribute names instead of emitting injected HTML", async () => {
  const application = createSSRApp({ render: () => h("div", { "data-id": "safe", "data-x\ronmouseover": "alert(1)" }, "商品") });
  application.config.warnHandler = () => {};
  const html = await renderToString(application);
  assert.match(html, /data-id="safe"/);
  assert.match(html, /商品/);
  assert.doesNotMatch(html, /onmouseover|alert\(1\)/);
});
