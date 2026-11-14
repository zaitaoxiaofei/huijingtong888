import bwipjs from 'bwip-js/browser';

export const INVENTORY_LABEL_SIZE = { width: 70, height: 30 };
export const MAX_INVENTORY_LABELS = 1000;

export function inventoryLabelType(product) {
  if (Number(product.is_consumable)) return '耗材';
  if (Number(product.component_count) > 0) return '套装';
  return Number(product.is_accessory) ? '配件' : '单品';
}

// Deduplicate by stable product identity, never by a potentially shared display number.
export function inventoryLabelItems(products) {
  return [...new Map(products.map(product => [Number(product.id), product])).values()]
    .map(product => ({
      id: Number(product.id),
      number: String(product.inventory_number || product.inventory_id || product.code || '').trim(),
      name: String(product.name || '').replace(/\s+/g, ' ').trim(),
      type: inventoryLabelType(product),
      quantity: Number.isSafeInteger(Number(product.physical_stock)) && Number(product.physical_stock) > 0 ? Number(product.physical_stock) : 1
    }));
}

export function validateInventoryLabels(items) {
  if (!items.length) throw new Error('请先选择需要打印标签的库存');
  const seen = new Set();
  let total = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || seen.has(item.id)) throw new Error('库存选择重复或已失效，请重新选择');
    seen.add(item.id);
    if (!item.number || !item.name) throw new Error('所选库存缺少编号或名称，请先编辑补充后再打印');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_INVENTORY_LABELS) {
      throw new Error(`每项标签数量须为 1–${MAX_INVENTORY_LABELS} 的整数`);
    }
    total += item.quantity;
  }
  if (total > MAX_INVENTORY_LABELS) throw new Error(`一次最多生成 ${MAX_INVENTORY_LABELS} 张标签，请分批打印`);
  return total;
}

export function wrapLabelName(text, measure, maxWidth) {
  const lines = [];
  let line = '';
  const tokens = text.match(/[A-Za-z0-9]+(?:[-/.+][A-Za-z0-9]+)*|\s+|[^\s]/gu) || [];
  for (const token of tokens) {
    const parts = measure(token) > maxWidth ? [...token] : [token];
    for (const part of parts) {
      if (line && measure(line + part) > maxWidth) {
        lines.push(line.trim());
        line = part.trimStart();
      } else line += part;
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

// The preview, PDF and print pages share these 300 dpi pixels, including Chinese glyphs.
export function renderInventoryLabel(item) {
  const canvas = document.createElement('canvas');
  canvas.width = 827;
  canvas.height = 354;
  const ctx = canvas.getContext('2d');
  const family = 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  let numberSize = 128;
  do { ctx.font = `800 ${numberSize}px ${family}`; numberSize -= 1; }
  while (ctx.measureText(item.number).width > 340 && numberSize >= 40);
  if (ctx.measureText(item.number).width > 340) throw new Error(`${item.number}：编号过长，无法完整排入标签`);
  ctx.fillText(item.number, 30, 157);

  ctx.font = `700 28px ${family}`;
  const badgeWidth = 104, badgeX = canvas.width - 30 - badgeWidth;
  ctx.lineWidth = item.type === '配件' ? 4 : 2;
  if (item.type === '套装' || item.type === '耗材') {
    ctx.fillRect(badgeX, 20, badgeWidth, 44);
    ctx.fillStyle = '#fff';
  } else ctx.strokeRect(badgeX, 20, badgeWidth, 44);
  ctx.fillText(item.type, badgeX + (badgeWidth - ctx.measureText(item.type).width) / 2, 52);
  ctx.fillStyle = '#000';
  const barcode = document.createElement('canvas');
  bwipjs.toCanvas(barcode, { bcid: 'code128', text: item.number, height: 8, scale: 3, includetext: false, paddingwidth: 10 });
  if (barcode.width > 360) bwipjs.toCanvas(barcode, { bcid: 'code128', text: item.number, height: 8, scale: 2, includetext: false, paddingwidth: 10 });
  // Keep module edges crisp and quiet zones intact at the label's 300 dpi resolution.
  if (barcode.width > 360) throw new Error(`${item.number}：条形码过长，无法清晰排入标签`);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(barcode, 389 + Math.floor((360 - barcode.width) / 2), 78, barcode.width, 84);
  ctx.font = `400 19px ${family}`;
  ctx.textAlign = 'center';
  ctx.fillText(item.number, 569, 184);
  ctx.textAlign = 'start';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(30, 203); ctx.lineTo(797, 203); ctx.stroke();

  let lines, size = 40;
  do {
    ctx.font = `600 ${size}px ${family}`;
    lines = wrapLabelName(item.name, text => ctx.measureText(text).width, 767);
    if (lines.length <= 2) break;
    size -= 1;
  } while (size >= 24);
  if (lines.length > 2) throw new Error(`${item.number}：名称过长，70 × 30 mm 标签无法清晰完整展示，请先缩短库存名称`);
  lines.forEach((line, index) => ctx.fillText(line, 30, lines.length === 1 ? 274 : 253 + index * 52));
  return canvas.toDataURL('image/png');
}

export async function generateInventoryLabels(items) {
  const total = validateInventoryLabels(items);
  await document.fonts.ready;
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle('库存标签 70 × 30 mm');
  const previews = [];
  for (const item of items) {
    const src = renderInventoryLabel(item);
    previews.push({ src, quantity: item.quantity });
    const image = await pdf.embedPng(src);
    for (let count = 0; count < item.quantity; count += 1) {
      const page = pdf.addPage([70 * 72 / 25.4, 30 * 72 / 25.4]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
  }
  return { bytes: await pdf.save(), previews, total };
}

export async function printInventoryLabels(previews) {
  const target = window.open('', '_blank');
  if (!target) throw new Error('打印窗口被浏览器拦截，请允许弹出窗口后重试，或下载 PDF 打印');
  target.opener = null;
  target.document.open();
  target.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>库存标签 · 70 × 30 mm</title><style>@page{size:70mm 30mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}#inventory-print-pages>img{display:block;width:70mm;height:30mm;break-after:page;page-break-after:always}#inventory-print-pages>img:last-child{break-after:auto;page-break-after:auto}@media print{body>:not(#inventory-print-pages){display:none!important}}@media screen{body{background:#eee}#inventory-print-pages>img{margin:12px auto}}</style></head><body><main id="inventory-print-pages"></main></body></html>');
  target.document.close();
  const ready = [];
  for (const preview of previews) for (let count = 0; count < preview.quantity; count += 1) {
    const image = target.document.createElement('img');
    image.alt = '库存标签';
    image.src = preview.src;
    target.document.getElementById('inventory-print-pages').append(image);
    ready.push(image.decode());
  }
  try {
    await Promise.all(ready);
    target.focus();
    target.print();
  } catch (error) {
    target.close();
    throw error;
  }
}
