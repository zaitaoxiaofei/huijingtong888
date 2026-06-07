function catalogProductsRuntime() {
  const runtime = globalThis.__ozonCatalogProductsRuntime;
  if (!runtime) throw new Error("Catalog products runtime is not configured");
  return runtime;
}

export function configureCatalogProductsRuntime(runtime) {
  globalThis.__ozonCatalogProductsRuntime = runtime;
}

export function products(query = {}) {
  return catalogProductsRuntime().productsImpl(query);
}

export function selectionProducts(query = {}) {
  return catalogProductsRuntime().selectionProductsImpl(query);
}

export function selectionProduct(id) {
  return catalogProductsRuntime().selectionProductImpl(id);
}

export function productImage(id) {
  return catalogProductsRuntime().productImageImpl(id);
}

export function productOrderProfitDetails(productId, query = {}) {
  return catalogProductsRuntime().productOrderProfitDetailsImpl(productId, query);
}

export function productCancelDetails(productId, query = {}) {
  return catalogProductsRuntime().productCancelDetailsImpl(productId, query);
}

export function hiddenProducts(query = {}) {
  return catalogProductsRuntime().hiddenProductsImpl(query);
}

export function restoreProduct(id) {
  return catalogProductsRuntime().restoreProductImpl(id);
}
