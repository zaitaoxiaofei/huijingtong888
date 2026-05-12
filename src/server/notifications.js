export function checkDailyPurchaseNotification(all) {
  const now = new Date();
  if (now.getHours() === 18 && now.getMinutes() === 0) generateDailyPurchaseNotification(all);
}

export function generateDailyPurchaseNotification(all) {
  try {
    const pendingRequests = all(`
      SELECT pr.*, p.name AS product_name, p.code AS product_code, p.image_url AS product_image_url,
             pe.name AS person_name
      FROM procurement_requests pr
      JOIN products p ON p.id = pr.product_id
      JOIN people pe ON pe.id = pr.person_id
      WHERE pr.status = 'submitted'
      ORDER BY pr.created_at DESC
    `);
    if (!pendingRequests.length) return;
    const merged = {};
    for (const r of pendingRequests) {
      const key = r.product_id;
      if (!merged[key]) {
        merged[key] = { product_name: r.product_name, product_code: r.product_code, total_quantity: 0, total_amount: 0, request_count: 0 };
      }
      merged[key].total_quantity += Number(r.quantity || 0);
      merged[key].total_amount += Number(r.amount || 0) + Number(r.shipping_amount || 0);
      merged[key].request_count++;
    }
    const productList = Object.values(merged);
    const totalProducts = productList.length;
    const totalQuantity = productList.reduce((s, m) => s + m.total_quantity, 0);
    const totalAmount = productList.reduce((s, m) => s + m.total_amount, 0);
    console.log(`[閲囪喘閫氱煡] ${new Date().toLocaleString()} - 褰撴棩閲囪喘娓呭崟宸茬敓鎴愶細${totalProducts} 绉嶄骇鍝侊紝${totalQuantity} 浠讹紝鎬婚噾棰?楼${totalAmount.toFixed(2)}`);
  } catch (error) {
    console.error("[閲囪喘閫氱煡] 鐢熸垚澶辫触:", error.message);
  }
}
