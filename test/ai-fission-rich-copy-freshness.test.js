import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const functions = parse(script, { ecmaVersion: "latest", sourceType: "module" }).body
  .filter(node => node.type === "FunctionDeclaration").map(node => script.slice(node.start, node.end)).join("\n");
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(saveHook = async () => {}) {
  const calls = [];
  const context = vm.createContext({ rowPreparationTasks: new Map(), queuedRowPreparationTasks: new Map(),
    preparedRowImageSignatures: new Map(), rowPreparationQueue: [], activeBackgroundDraftPreparations: 0,
    BACKGROUND_DRAFT_PREPARATION_CONCURRENCY: 10, ElMessage: { warning() {}, success() {}, error() {} } });
  vm.runInContext(functions, context);
  Object.assign(context, {
    rowMainImageDraftUrl: row => row.main, resultImageUrl: row => row.main, rowResultId: row => row.id,
    rowTitleOutput: row => row.title, rowDescriptionOutput: row => row.description,
    rowVideoUrls: () => [], persistGeneratedRowAssets: async () => {},
    saveRowAsset: async (row, field, asset) => {
      calls.push({ field, asset: clone(asset) });
      await saveHook(row, asset, calls.length);
      row.assets = { ...row.assets, [field]: clone(asset) };
      return { asset };
    }
  });
  const row = { id: "target-row", target_variant_value: "HAVAL F7", main: "https://media.example/main.png",
    title: "Накладки HAVAL F7", description: "Описание HAVAL F7 до редактирования.", assets: {} };
  return { context, row, calls };
}
const content = json => JSON.parse(json).content[0].blocks[0];

test("restored automatic rich content follows the current description, title and target even with the same image", () => {
  const { context, row } = fixture();
  row.assets.rich_content = { json: context.buildRowRichContentJson(row) };
  row.target_variant_value = "HAVAL H9";
  row.title = "Накладки HAVAL H9";
  row.description = "Новое описание HAVAL H9 после редактирования.";
  const block = content(context.rowRichContentOutput(row));
  assert.equal(block.title.items[0].content, row.title);
  assert.equal(block.text.items[0].content, row.description);
  assert.equal(block.img.alt, row.title);
});

test("image replacement and a later description edit produce one current automatic rich result", async () => {
  const { context, row } = fixture();
  row.assets.rich_content = { json: context.buildRowRichContentJson(row) };
  row.main = "https://media.example/replaced.png";
  row.description = "Текущее описание после замены изображения.";
  await context.prepareGeneratedRowForDraft(row, { silent: true, generateVideo: false });
  const block = content(context.rowRichContentOutput(row));
  assert.equal(block.img.src, row.main);
  assert.equal(block.text.items[0].content, row.description);
  assert.equal(content(row.assets.rich_content.json).text.items[0].content, row.description);
});

test("preparation of the same image reruns after copy changes instead of using the old image-only cache", async () => {
  const { context, row, calls } = fixture();
  await context.queueGeneratedRowPreparation(row, { silent: true, generateVideo: false });
  const firstCount = calls.length;
  row.description = "Вторая версия описания HAVAL F7.";
  await context.queueGeneratedRowPreparation(row, { silent: true, generateVideo: false });
  assert.ok(calls.length > firstCount);
  assert.equal(content(row.assets.rich_content.json).text.items[0].content, row.description);
});

test("an edit during asynchronous rich persistence is saved again before preparation reports completion", async () => {
  const pending = deferred(), entered = deferred();
  const { context, row, calls } = fixture(async (_row, _asset, count) => {
    if (count === 1) { entered.resolve(); await pending.promise; }
  });
  const work = context.prepareGeneratedRowForDraft(row, { silent: true, generateVideo: false });
  await entered.promise;
  row.title = "Обновлённый заголовок HAVAL F7";
  row.description = "Описание изменено во время сохранения.";
  pending.resolve();
  await work;
  assert.ok(calls.length >= 2);
  const block = content(row.assets.rich_content.json);
  assert.equal(block.title.items[0].content, row.title);
  assert.equal(block.text.items[0].content, row.description);
});

test("continuous copy edits stop after three writes and never report rich content as done", async () => {
  const { context, row, calls } = fixture(async (current, _asset, count) => {
    current.description = `Описание продолжает меняться ${count}.`;
  });
  await assert.rejects(context.generateRowRichContent(row, { silent: true, throwOnError: true }), /确认当前主图、标题和描述后重试/);
  assert.equal(calls.length, 3);
  assert.equal(row.richContentStatus, "failed");
});

test("copy edits while video preparation waits refresh rich content before recording the prepared signature", async () => {
  const entered = deferred(), video = deferred();
  const { context, row, calls } = fixture();
  context.generateRowVideo = async () => { entered.resolve(); await video.promise; };
  const work = context.queueGeneratedRowPreparation(row, { silent: true, generateVideo: true });
  await entered.promise;
  row.description = "Описание изменено во время ожидания видео.";
  video.resolve();
  await work;
  assert.equal(content(row.assets.rich_content.json).text.items[0].content, row.description);
  assert.equal(context.preparedRowImageSignatures.get(row.id), context.rowRichContentSignature(row));
  const before = calls.length;
  await context.queueGeneratedRowPreparation(row, { silent: true, generateVideo: true });
  assert.equal(calls.length, before);
});

test("custom restored rich layouts retain their own copy and extra blocks", async () => {
  const { context, row, calls } = fixture();
  const manual = { version: 0.3, content: [{ widgetName: "custom-layout", blocks: [
    { img: { src: "https://media.example/old.png" }, text: { value: "Manual text remains" } },
    { customText: "A second manual block" }
  ] }] };
  row.assets.rich_content = { json: JSON.stringify(manual) };
  await context.prepareGeneratedRowForDraft(row, { silent: true, generateVideo: false });
  const output = JSON.parse(context.rowRichContentOutput(row));
  assert.equal(output.content[0].widgetName, "custom-layout");
  assert.equal(output.content[0].blocks[0].text.value, "Manual text remains");
  assert.deepEqual(output.content[0].blocks[1], manual.content[0].blocks[1]);
  assert.equal(calls.length, 0);
});

test("custom multi-image rich content updates only its first image and repeated references to that image", () => {
  const { context, row } = fixture();
  const oldMain = "https://media.example/original-main.png", detail = "https://media.example/detail.png";
  const manual = { version: 0.3, customLayout: "preserve-layout", link: oldMain, content: [{ widgetName: "custom-layout", blocks: [
    { img: { src: oldMain, srcMobile: oldMain, alt: "Original alt" }, text: { value: "Keep manual copy" }, href: oldMain },
    { img: { src: detail, srcMobile: detail }, text: { value: "Keep detail copy" } },
    { img: { src: oldMain, srcMobile: oldMain }, customMetadata: [1, 2] }
  ] }] };
  const before = JSON.stringify(manual);
  row.assets.rich_content = { json: before };
  const expected = clone(manual);
  for (const index of [0, 2]) {
    expected.content[0].blocks[index].img.src = row.main;
    expected.content[0].blocks[index].img.srcMobile = row.main;
  }
  assert.deepEqual(JSON.parse(context.rowRichContentOutput(row)), expected);
  assert.equal(JSON.stringify(manual), before);
});

test("a current legacy asset can be restored as an object without mutation or unnecessary persistence", async () => {
  const { context, row, calls } = fixture();
  const legacy = JSON.parse(context.buildRowRichContentJson(row));
  row.assets.rich_content = { richContentJson: legacy };
  const before = JSON.stringify(legacy);
  await context.prepareGeneratedRowForDraft(row, { silent: true, generateVideo: false });
  assert.equal(content(context.rowRichContentOutput(row)).text.items[0].content, row.description);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(calls.length, 0);
});

test("a manually customized automatic-looking layout is retained when no generator marker exists", async () => {
  const { context, row, calls } = fixture();
  const manual = JSON.parse(context.buildRowRichContentJson(row));
  manual.content[0].blocks[0].text.color = "custom-color";
  row.assets.rich_content = { json: JSON.stringify(manual) };
  row.description = "A newer description does not overwrite manual rich copy.";
  await context.prepareGeneratedRowForDraft(row, { silent: true, generateVideo: false });
  assert.equal(content(context.rowRichContentOutput(row)).text.color, "custom-color");
  assert.equal(content(context.rowRichContentOutput(row)).text.items[0].content, manual.content[0].blocks[0].text.items[0].content);
  assert.equal(calls.length, 0);
});
