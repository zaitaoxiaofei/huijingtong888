import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function buildInventoryOperationsPreview(outDir=path.resolve('.verification/inventory-operations-preview')){
 await build({configFile:false,root:process.cwd(),base:'./',logLevel:'error',plugins:[vue(),{name:'inventory-operations-preview',resolveId:id=>id==='virtual:inventory-operations'?'\0inventory-operations':undefined,load:id=>id==='\0inventory-operations'?`import {createApp} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import 'element-plus/theme-chalk/dark/css-vars.css';import Preview from '/frontend/design-previews/InventoryOperationsPreview.vue';createApp(Preview).use(ElementPlus).mount('#app');`:undefined}],build:{outDir,emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:'virtual:inventory-operations',output:{entryFileNames:'entry.js',chunkFileNames:'assets/[name]-[hash].js'}}}});
 const css=(await fs.readdir(path.join(outDir,'assets'))).find(f=>f.endsWith('.css'));
 await fs.writeFile(path.join(outDir,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>库存工作队列 · 设计预览</title><link rel="stylesheet" href="./assets/${css}"><style>:root{--el-color-primary:#315db2;--el-color-primary-light-9:#eef4ff;--el-color-primary-light-7:#c4d5ef;--el-font-size-base:13px}body{margin:0;font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:var(--el-bg-color-page);color:var(--el-text-color-primary)}</style></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>`);
 return outDir;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname)console.log(await buildInventoryOperationsPreview());
