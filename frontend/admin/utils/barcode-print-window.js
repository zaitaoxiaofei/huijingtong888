export function openBarcodePrintWindow() {
  const preview = window.open("", "_blank");
  if (!preview) throw new Error("浏览器阻止了打印预览，请允许本站打开弹窗后重试");
  preview.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>条码打印确认</title>
    <style>body{margin:0;font:16px sans-serif;background:#f1f5f9}header{padding:16px;background:white}button,a{margin-right:12px}iframe{width:100%;height:calc(100vh - 140px);border:0}</style></head>
    <body><header><strong>条码打印确认</strong><p id="status">正在生成 PDF，请稍候…</p>
    <button id="print" disabled>打印</button><a id="pdf" target="_blank" rel="noopener" hidden>打开 PDF</a><button id="close">关闭</button></header>
    <iframe id="barcode" title="条码 PDF"></iframe></body></html>`);
  preview.document.close();
  preview.document.getElementById("close").onclick = () => preview.close();
  let url = "";
  const timer = window.setInterval(() => {
    if (!preview.closed) return;
    window.clearInterval(timer);
    if (url) URL.revokeObjectURL(url);
  }, 600);
  return {
    show(blob, onPrint) {
      if (preview.closed) throw new Error("打印预览已关闭，请重新点击打印");
      url = URL.createObjectURL(blob);
      const frame = preview.document.getElementById("barcode");
      const button = preview.document.getElementById("print");
      const status = preview.document.getElementById("status");
      const link = preview.document.getElementById("pdf");
      link.href = url;
      link.hidden = false;
      status.textContent = "正在加载 PDF；如预览未显示，可点击“打开 PDF”。";
      frame.onload = () => {
        button.disabled = false;
        status.textContent = "确认条码显示完整后点击“打印”；打印完成后请回备货单确认结果。";
      };
      frame.src = url;
      button.onclick = () => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          onPrint();
        } catch {
          status.textContent = "无法调用打印，请点击“打开 PDF”，使用 PDF 页面的打印按钮。";
        }
      };
      // Opening the PDF is also a manual print route; completion still needs operator confirmation.
      link.onclick = onPrint;
    },
    showError(message) {
      if (!preview.closed) preview.document.getElementById("status").textContent = message;
    }
  };
}
