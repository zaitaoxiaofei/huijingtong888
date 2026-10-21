import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assetVariantExecutionScope, assetVariantTenantPredicate, assetVariantTenantScope } from "../../src/services/asset-variant-tenant-scope.js";

export const assetVariantSource = readFileSync(new URL("../../src/services/asset-variant-engine.js", import.meta.url), "utf8");
export const listingSource = readFileSync(new URL("../../src/services/listing-automation.js", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing service section: ${start}`);
  return source.slice(from, to).replaceAll("export ", "");
}

export function loadAssetVariantConfigService({ query, execute = async () => ({ insertId: 99 }), transaction, readFile = async () => Buffer.from("tail") } = {}) {
  const context = vm.createContext({
    Buffer, Date, Number, String, Object, Array, Map, Set, path,
    ROOT_DIR: "/fixture", TAIL_TEMPLATE_ROOT: "/fixture/tails",
    fs: { readFile },
    assetVariantExecutionScope, assetVariantTenantPredicate, assetVariantTenantScope,
    mysqlQuery: query, mysqlExecute: execute,
    withMysqlTransaction: transaction || (async action => action({ execute: async (sql, params) => [await execute(sql, params)] })),
    ensureAssetVariantSchema: async () => {}, ensureVehicleSeedData: async () => {},
    assetVehicleModels: async () => [], assetOzonCategoryMappings: async () => [],
    TITLE_STYLES: ["traffic"], TAG_STYLES: ["traffic"], MAIN_IMAGE_PLANS: [{ value: "original" }],
    TITLE_STYLE_LABELS: { traffic: "Traffic" }, TAG_STYLE_LABELS: { traffic: "Traffic" },
    DEFAULT_TAIL_CATEGORY: "Auto accessories", DEFAULT_TAIL_MODEL: "Generic model",
    normalizeShopRuleRow: row => ({ id: Number(row.id), name: row.name, rule: row }),
    normalizeWatermarkTemplate: row => row,
    normalizeTailTemplate: row => ({ ...row, id: Number(row.id), shopId: row.shop_id, imagePath: row.image_path }),
    normalizeUrl: value => value, resolveLocalAssetPath: value => value,
    uniqueValues: values => [...new Set(values.filter(Boolean))],
    cleanText: (value, limit) => String(value || "").trim().slice(0, limit),
    normalizeTitleStyle: value => value || "traffic", normalizeTagStyle: value => value || "traffic",
    normalizePriceIndex: value => Number(value || 1), normalizePriceRole: value => value || "",
    normalizeSecond: value => String(value), personId: session => Number(session?.personId || 0),
    storeTailTemplateImage: async () => "https://fixture.invalid/uploaded.png",
    publishTailTemplateImageForOzon: async value => value || "",
    mimeForPath: () => "image/png"
  });
  vm.runInContext([
    section(assetVariantSource, "export async function assetVariantBootstrap", "export async function selectionPublishShops"),
    section(assetVariantSource, "export async function saveShopVariantRule", "export async function generateAssetVariants"),
    section(assetVariantSource, "async function requireAssetVariantShop", "export async function syncAssetOzonCategories"),
    section(assetVariantSource, "export async function createAssetTailTemplate", "export async function resolveAssetVariantFile")
  ].join("\n"), context);
  return context;
}

export function loadShopTailResolver(query) {
  const context = vm.createContext({
    Number, String,
    row: async (sql, params) => (await query(sql, params))[0] || null,
    listingTenantId: session => session?.tenant?.slug === "default" ? "admin" : String(session.tenant.id),
    materializeShopTailImageForPublish: async value => value || ""
  });
  vm.runInContext(section(listingSource, "async function resolveShopTailImageUrl", "function normalizeShopTailImageUrl"), context);
  return context.resolveShopTailImageUrl;
}
