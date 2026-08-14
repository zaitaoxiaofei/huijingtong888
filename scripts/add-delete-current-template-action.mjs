import fs from "node:fs";

const LEGACY_RUNTIME_PROXY_PATCH = true;
if (process.env.ALLOW_RUNTIME_PROXY_PATCH !== "1") {
  throw new Error(
    "This legacy script edits built AI workbench runtime assets directly. Set ALLOW_RUNTIME_PROXY_PATCH=1 only for an explicit, reviewed emergency patch."
  );
}

const runtimePath = new URL("../public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js", import.meta.url);
let source = fs.readFileSync(runtimePath, "utf8");

if (!source.includes("import{a as We,i as Ge,s as Ke,t as qe}from")) {
  throw new Error("Prompt template import block not found.");
}

source = source.replace(
  "import{a as We,i as Ge,s as Ke,t as qe}from",
  "import{a as We,i as Ge,n as otDelete,s as Ke,t as qe}from"
);

const anchor = "function Wo(){return{name:String(B.name||``).trim(),keywords:String(B.keywords||``).trim(),scene:yi,mode:bi,description:`AI商品裂变三步字段提示词模板`,positive_prompt:[H.visualPositive,H.textPositive].filter(Boolean).join(`\\r\\n`),negative_prompt:[H.visualNegative,H.textNegative].filter(Boolean).join(`\\r\\n`),promptPayload:Ro(),prompt_payload_json:JSON.stringify(Ro()),main_image_prompt:templateWorkbenchFieldPromptValue(`mainImage`),detail_image_prompt_json:templateWorkbenchDetailPromptJson(),title_prompt:templateWorkbenchFieldPromptValue(`title`),tags_prompt:templateWorkbenchFieldPromptValue(`tags`),description_prompt:templateWorkbenchFieldPromptValue(`description`),variables:[`variant_type`,`variant_value`,`source_model`,`target_model`,`product_type`,`brand`,`material`,`color`],enabled:1,sort_order:0}}";

if (!source.includes(anchor)) {
  throw new Error("Template save block anchor not found.");
}

const insertAfter = "async function Ko(){let e=Lo();if(!e?.id){S.warning(`请先选择要更新的模板，或保存为新模板`);return}try{await ye.confirm(`确认更新模板「${e.name}」？`,`更新裂变提示词模板`,{type:`warning`,confirmButtonText:`更新`,cancelButtonText:`取消`})}catch{return}let t={...Wo(),updatedAt:e.updatedAt||e.updated_at||``};B.saving=!0;try{let n=await Ke(e.id,t);await Fo(),templateWorkbenchApplySavedTemplate({...n,id:n.id||e.id},{refreshList:!0}),S.success(`裂变提示词模板已更新`)}catch(e){S.error(e.message||`更新模板失败`)}finally{B.saving=!1}}";

const deleteBlock = "async function tlDeleteCurrentTemplate(){let e=Lo();if(!e?.id){S.warning(`请先选择要删除的模板`);return}try{await ye.confirm(`确认删除模板「${e.name}」？`,`删除裂变提示词模板`,{type:`warning`,confirmButtonText:`删除`,cancelButtonText:`取消`})}catch{return}B.saving=!0;try{await otDelete(e.id),await Fo(),B.selectedId=``,B.name=``,B.keywords=``,B.keyword=``,S.success(`当前模板已删除`)}catch(e){S.error(e.message||`删除模板失败`)}finally{B.saving=!1}}";

if (!source.includes(insertAfter)) {
  throw new Error("Update block not found.");
}

source = source.replace(insertAfter, `${insertAfter}${deleteBlock}`);

const buttonBlock = "i(`div`,an,[a(Button,{type:`primary`,plain:``,onClick:l[13]||=e=>ra.value=!0},{default:x(()=>[...l[143]||=[d(`打开完整配置`,-1)]]),_:1}),a(Button,{loading:B.saving,onClick:Go},{default:x(()=>[...l[144]||=[d(`保存为新模板`,-1)]]),_:1},8,[`loading`]),a(Button,{loading:B.saving,onClick:Ko},{default:x(()=>[...l[145]||=[d(`覆盖当前模板`,-1)]]),_:1},8,[`loading`])])";

const newButtonBlock = "i(`div`,an,[a(Button,{type:`primary`,plain:``,onClick:l[13]||=e=>ra.value=!0},{default:x(()=>[...l[143]||=[d(`打开完整配置`,-1)]]),_:1}),a(Button,{loading:B.saving,onClick:Go},{default:x(()=>[...l[144]||=[d(`保存为新模板`,-1)]]),_:1},8,[`loading`]),a(Button,{loading:B.saving,onClick:Ko},{default:x(()=>[...l[145]||=[d(`覆盖当前模板`,-1)]]),_:1},8,[`loading`]),a(Button,{type:`danger`,plain:``,loading:B.saving,disabled:!B.selectedId,onClick:tlDeleteCurrentTemplate},{default:x(()=>[...l[350]||=[d(`删除当前模板`,-1)]]),_:1},8,[`loading`,`disabled`])])";

if (!source.includes(buttonBlock)) {
  throw new Error("Template action button block not found.");
}

source = source.replace(buttonBlock, newButtonBlock);

fs.writeFileSync(runtimePath, source, "utf8");
console.log("Delete current template action added.");
