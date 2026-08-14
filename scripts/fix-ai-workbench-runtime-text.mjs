import fs from "node:fs";

const LEGACY_RUNTIME_PROXY_PATCH = true;
if (process.env.ALLOW_RUNTIME_PROXY_PATCH !== "1") {
  throw new Error(
    "This legacy script edits built AI workbench runtime assets directly. Set ALLOW_RUNTIME_PROXY_PATCH=1 only for an explicit, reviewed emergency patch."
  );
}

const path = new URL("../public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js", import.meta.url);
let source = fs.readFileSync(path, "utf8");

const start = source.indexOf("function Wo(){");
const end = source.indexOf("let qo=l(()=>", start);

if (start < 0 || end < 0) {
  throw new Error("Unable to locate template save block in runtime asset.");
}

const replacement = `function Wo(){return{name:String(B.name||\`\`).trim(),keywords:String(B.keywords||\`\`).trim(),scene:yi,mode:bi,description:\`AI商品裂变三步字段提示词模板\`,positive_prompt:[H.visualPositive,H.textPositive].filter(Boolean).join(\`\\r\\n\`),negative_prompt:[H.visualNegative,H.textNegative].filter(Boolean).join(\`\\r\\n\`),promptPayload:Ro(),prompt_payload_json:JSON.stringify(Ro()),main_image_prompt:templateWorkbenchFieldPromptValue(\`mainImage\`),detail_image_prompt_json:templateWorkbenchDetailPromptJson(),title_prompt:templateWorkbenchFieldPromptValue(\`title\`),tags_prompt:templateWorkbenchFieldPromptValue(\`tags\`),description_prompt:templateWorkbenchFieldPromptValue(\`description\`),variables:[\`variant_type\`,\`variant_value\`,\`source_model\`,\`target_model\`,\`product_type\`,\`brand\`,\`material\`,\`color\`],enabled:1,sort_order:0}}async function Go(){let e=Wo();if(!e.name){S.warning(\`请先填写模板名\`);return}B.saving=!0;try{let t=await qe(e);await Fo(),templateWorkbenchApplySavedTemplate(t,{refreshList:!0}),S.success(\`裂变提示词模板已保存到数据库\`)}catch(e){S.error(e.message||\`保存模板失败\`)}finally{B.saving=!1}}async function Ko(){let e=Lo();if(!e?.id){S.warning(\`请先选择要更新的模板，或保存为新模板\`);return}try{await ye.confirm(\`确认更新模板「\${e.name}」？\`,\`更新裂变提示词模板\`,{type:\`warning\`,confirmButtonText:\`更新\`,cancelButtonText:\`取消\`})}catch{return}let t={...Wo(),updatedAt:e.updatedAt||e.updated_at||\`\`};B.saving=!0;try{let n=await Ke(e.id,t);await Fo(),templateWorkbenchApplySavedTemplate({...n,id:n.id||e.id},{refreshList:!0}),S.success(\`裂变提示词模板已更新\`)}catch(e){S.error(e.message||\`更新模板失败\`)}finally{B.saving=!1}}`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(path, source, "utf8");

console.log("Runtime template-save text fixed.");
