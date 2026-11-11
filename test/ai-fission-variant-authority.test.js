import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const functions = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
  .map(node => source.slice(node.start, node.end)).join("\n");
const clone = value => JSON.parse(JSON.stringify(value));
const sourceMain = "https://media.example/current-source.jpg";
const targetMain = "https://media.example/generated-target.jpg";
const detail = "https://media.example/current-detail.jpg";

function fixture() {
  const context = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map() });
  vm.runInContext(functions, context);
  const base = {
    title: "Historical template", editable_payload: {
      dimensions: { weight_g: 200 },
      variants: Array.from({ length: 4 }, (_, index) => ({
        id: `legacy-${index}`, offer_id: `TENET-${index}`, title: `TENET ${index}`,
        images: [`https://media.example/legacy-${index}.jpg`],
        attributes: [{ attribute_id: 9048, name: "Model", value: `TENET ${index}` }],
        dynamic_attributes: { "9048": { attribute_id: 9048, value: `TENET ${index}` } },
        video_urls: [`https://media.example/legacy-${index}.mp4`]
      }))
    }
  };
  const currentVariant = {
    id: "current-source", offer_id: "MAZDA-CX5", title: "Mazda CX5",
    images: [sourceMain, detail],
    attributes: [{ attribute_id: 9048, name: "Model", value: "Mazda CX5" }],
    dynamic_attributes: { "9048": { attribute_id: 9048, value: "Mazda CX5" } }
  };
  return { context, base, currentVariant };
}

test("AI fission uses exactly the current draft SKU rows without historical siblings or row fields", () => {
  const { context, base, currentVariant } = fixture();
  const snapshot = { editable_payload: { variants: [currentVariant] } };
  const before = JSON.stringify({ base, snapshot });
  const result = context.mergeAiVariantTemplateSnapshot(base, snapshot);
  assert.deepEqual(clone(result.editable_payload.variants), [currentVariant]);
  assert.equal(JSON.stringify({ base, snapshot }), before);
});

test("AI fission retains a snapshot's explicit empty SKU list", () => {
  const { context, base } = fixture();
  const result = context.mergeAiVariantTemplateSnapshot(base, { editable_payload: { variants: [] } });
  assert.deepEqual(clone(result.editable_payload.variants), []);
});

test("legacy snapshots missing a SKU array retain base rows and shared package facts", () => {
  const { context, base } = fixture();
  for (const variants of [undefined, null, "invalid", {}]) {
    const editable = variants === undefined ? {} : { variants };
    const snapshot = context.normalizeAiVariantSourceTemplateSnapshot({ template_payload: {
      title: "Legacy snapshot", editable_payload: editable
    } });
    const result = context.mergeAiVariantTemplateSnapshot(base, snapshot);
    assert.deepEqual(clone(result.editable_payload.variants), base.editable_payload.variants);
    assert.equal(result.editable_payload.dimensions.weight_g, 200);
  }
});

test("reordered current SKU rows do not inherit facts from the previous row at that index", () => {
  const { context, base, currentVariant } = fixture();
  const second = { id: "second-current", offer_id: "MAZDA-CX3", title: "Mazda CX3", images: [] };
  const rows = [second, currentVariant];
  const result = context.mergeAiVariantTemplateSnapshot(base, { editable_payload: { variants: rows } });
  assert.deepEqual(clone(result.editable_payload.variants), rows);
});

test("cleared current SKU attributes and removed media stay cleared even for the same SKU ID", () => {
  const { context, base } = fixture();
  const currentVariant = {
    id: base.editable_payload.variants[0].id,
    offer_id: base.editable_payload.variants[0].offer_id,
    attributes: [], dynamic_attributes: {}, images: [], images_manually_edited: true
  };
  const result = context.mergeAiVariantTemplateSnapshot(base, { editable_payload: { variants: [currentVariant] } });
  assert.deepEqual(clone(result.editable_payload.variants), [currentVariant]);
});

test("both fission snapshot merges keep one current SKU while applying its target title and main image", () => {
  const { context, base, currentVariant } = fixture();
  const snapshot = { editable_payload: { variants: [currentVariant], images: [sourceMain, detail] } };
  const before = JSON.stringify({ base, snapshot });
  const sourceTemplate = context.mergeAiVariantTemplateSnapshot(base, snapshot);
  const patched = context.applyAiVariantDraftPatch(sourceTemplate.editable_payload, {
    offer_id: "VAR-MAZDA-CX3", title: "Mazda CX3", images: [targetMain, detail]
  });
  const final = context.mergeAiVariantTemplateSnapshot(base, { editable_payload: patched });
  assert.equal(final.editable_payload.variants.length, 1);
  const target = final.editable_payload.variants[0];
  assert.equal(target.title, "Mazda CX3");
  assert.equal(target.offer_id, "VAR-MAZDA-CX3");
  assert.deepEqual(clone(target.images).map(image => image.url || image), [targetMain, detail]);
  assert.equal(target.video_urls, undefined);
  assert.equal(JSON.stringify({ base, snapshot }), before);
});

test("AI lab saving reloads current draft SKUs even when an explicit old snapshot was submitted", async () => {
  const { context, base, currentVariant } = fixture();
  const sourceSnapshot = { editable_payload: { variants: [currentVariant] } };
  const sourceRow = { id: 5529, template_id: 100, template_payload_json: JSON.stringify(sourceSnapshot) };
  const queries = [];
  const stopped = new Error("stop before persistence");
  let inherited;
  Object.assign(context, {
    ensureListingAutomationSchema: async () => {},
    findDuplicateAiMaterialOptimizerDraft: async () => null,
    listingTenantId: () => "tenant-test",
    mysqlQuery: async () => { throw new Error("unexpected database query"); },
    row: async (sql, params) => {
      queries.push({ sql, params });
      return sql.includes("FROM listing_drafts") ? sourceRow : { id: 100 };
    },
    assembleListingDraftStoredRow: async (_query, { row }) => row,
    normalizeTemplateRow: () => context.normalizeTemplatePayload(base),
    ensureAiVariantDraftVideoMedia: async (_body, patch) => patch,
    applyAiVariantDraftPatch: editable => { inherited = clone(editable); throw stopped; }
  });
  await assert.rejects(context.createAuthorizedAiVariantListingDraftLightweight({
    template_id: 100, source_draft_id: 5529, offer_id: "VAR-MAZDA-CX3",
    ai_optimization: { source: "ai_variant_lab" }, template_payload: base
  }, { tenant_id: "tenant-test" }), error => error === stopped);
  assert.deepEqual(inherited.variants, [currentVariant]);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.sql.includes("status <> 'deleted'") && query.params[1] === "tenant-test"));
});

async function repairFixture({ currentVariants, manualVariants }) {
  const { context, base } = fixture();
  let saved, persisted;
  const writes = [];
  Object.assign(context, {
    listingTenantId: () => "tenant-test",
    listingCategoryTemplateRaw: async id => id === 100 ? base : persisted,
    upsertAiVariantListingDraftTemplate: async input => {
      saved = clone(input);
      persisted = { title: input.title, editable_payload: input.editable };
      return 200;
    },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); }
  });
  const editable = currentVariants === undefined ? {} : { variants: currentVariants };
  const manualFacts = manualVariants === undefined ? {} : { variants: manualVariants };
  const repaired = await context.repairAiVariantDraftTemplateReference({
    id: 5530, template_id: 100, template_source_type: "historical-template",
    ai_payload: { source: "ai_optimization_v2_lightweight" },
    product_name: "Current target", source_images: [targetMain, detail],
    template_payload: { editable_payload: editable }, manual_facts: manualFacts
  });
  assert.equal(repaired, true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].sql.includes("COALESCE(tenant_id, 'admin') = ?"));
  assert.equal(writes[0].params.at(-1), "tenant-test");
  const stored = JSON.parse(writes[0].params[1]);
  return { saved, stored };
}

test("legacy AI draft template repair keeps the current draft's one SKU over stale manual facts", async () => {
  const { base, currentVariant } = fixture();
  const result = await repairFixture({ currentVariants: [currentVariant], manualVariants: base.editable_payload.variants });
  assert.deepEqual(result.saved.editable.variants, [currentVariant]);
  assert.deepEqual(result.stored.editable_payload.variants, [currentVariant]);
});

test("legacy AI draft template repair preserves an explicitly emptied current SKU list", async () => {
  const { base } = fixture();
  const result = await repairFixture({ currentVariants: [], manualVariants: base.editable_payload.variants });
  assert.deepEqual(result.saved.editable.variants, []);
  assert.deepEqual(result.stored.editable_payload.variants, []);
});

test("legacy AI draft template repair falls back to manual or base rows only when current SKUs are absent", async () => {
  const { base, currentVariant } = fixture();
  const manual = await repairFixture({ manualVariants: [currentVariant] });
  assert.deepEqual(manual.saved.editable.variants.map(variant => variant.offer_id), [currentVariant.offer_id]);
  const fallback = await repairFixture({});
  assert.deepEqual(fallback.saved.editable.variants.map(variant => variant.offer_id), base.editable_payload.variants.map(variant => variant.offer_id));
});
