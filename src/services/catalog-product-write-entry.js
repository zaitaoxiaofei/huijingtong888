function catalogProductWriteRuntime() {
  const runtime = globalThis.__ozonCatalogProductWriteRuntime;
  if (!runtime) throw new Error("Catalog product write runtime is not configured");
  return runtime;
}

export function configureCatalogProductWriteRuntime(runtime) {
  globalThis.__ozonCatalogProductWriteRuntime = runtime;
}

export function createProduct(body) {
  return catalogProductWriteRuntime().createProductImpl(body);
}

export function addSelectionToInventory(id) {
  return catalogProductWriteRuntime().addSelectionToInventoryImpl(id);
}

export function previewProductCsvImport(body = {}) {
  return catalogProductWriteRuntime().previewProductCsvImportImpl(body);
}

export function commitProductCsvImport(body = {}) {
  return catalogProductWriteRuntime().commitProductCsvImportImpl(body);
}

export function updateProduct(id, body) {
  return catalogProductWriteRuntime().updateProductImpl(id, body);
}

export function deleteProduct(id) {
  return catalogProductWriteRuntime().deleteProductImpl(id);
}

export function removeProductFromInventory(id) {
  return catalogProductWriteRuntime().removeProductFromInventoryImpl(id);
}

export function previewMergeProducts(body = {}) {
  return catalogProductWriteRuntime().previewMergeProductsImpl(body);
}

export function mergeProducts(body = {}) {
  return catalogProductWriteRuntime().mergeProductsImpl(body);
}

export function productMergeHistory(body = {}) {
  return catalogProductWriteRuntime().productMergeHistoryImpl(body);
}

export function undoMergeProductHistory(id) {
  return catalogProductWriteRuntime().undoMergeProductHistoryImpl(id);
}
