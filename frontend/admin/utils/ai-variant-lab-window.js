export function aiVariantLabUrl(query = {}) {
  const params = new URLSearchParams();
  Object.entries({
    workbenchId: `ailab-${Date.now().toString(36)}`,
    standalone: "1",
    ...query
  }).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/admin.html#/ai-variant-lab${suffix}`;
}

export function openAiVariantLabWindow(query = {}) {
  const url = aiVariantLabUrl(query);
  window.open(url, "_blank", "noopener,noreferrer");
  return url;
}

export function aiProductMaterialOptimizerUrl(query = {}) {
  const params = new URLSearchParams();
  Object.entries({
    workbenchId: `aimat-${Date.now().toString(36)}`,
    standalone: "1",
    ...query
  }).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/admin.html#/ai-product-material-optimizer${suffix}`;
}

export function openAiProductMaterialOptimizerWindow(query = {}) {
  const url = aiProductMaterialOptimizerUrl(query);
  window.open(url, "_blank", "noopener,noreferrer");
  return url;
}

export function aiEcommerceSuiteUrl(query = {}) {
  const params = new URLSearchParams();
  Object.entries({
    standalone: "1",
    ...query
  }).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/admin.html#/ai-ecommerce-suite${suffix}`;
}

export function openAiEcommerceSuiteWindow(query = {}) {
  const url = aiEcommerceSuiteUrl(query);
  window.open(url, "_blank", "noopener,noreferrer");
  return url;
}
