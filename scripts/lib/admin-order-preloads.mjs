// Resolve only the current order mode's static dependency graph. Other routes
// and heavy detail dialogs keep their lazy-loading boundaries.
export function adminOrderPreloadScript(manifest) {
  const entry = 'frontend/admin/main.js';
  const orders = 'frontend/admin/views/orders/OrdersView.vue';
  const print = 'frontend/orders/OrdersPage.vue';
  const inventory = 'frontend/admin/components/inventory/InventorySupplyWorkspace.vue';
  const collect = roots => {
    const seen = new Set([entry]), files = new Set();
    const visit = key => {
      if (seen.has(key)) return;
      seen.add(key);
      const item = manifest[key];
      if (!item) return;
      if (/^assets\/[A-Za-z0-9_.-]+\.js$/.test(item.file || '')) files.add('/vue-apps/' + item.file);
      for (const child of item.imports || []) visit(child);
    };
    roots.forEach(visit);
    return [...files];
  };
  const paths = {print:collect([orders,print]),inventory:collect([orders,inventory])};
  return `(function(){if(!/^#\\/orders(?:[?]|$)/.test(location.hash))return;var mode=new URLSearchParams(location.hash.split('?')[1]||'').get('mode')==='inventory'?'inventory':'print';var paths=${JSON.stringify(paths)};paths[mode].forEach(function(href){if(document.querySelector('link[rel="modulepreload"][href="'+href+'"]'))return;var link=document.createElement('link');link.rel='modulepreload';link.href=href;document.head.appendChild(link);});})();`;
}
