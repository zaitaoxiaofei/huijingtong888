export const FOCUSED_TRAFFIC_TAG='重点关注';
export const DEFAULT_TRAFFIC_TAGS=[FOCUSED_TRAFFIC_TAG,'新品开发期','测品'];
export function normalizeTrafficTags(value){
 if(!Array.isArray(value)||value.length>12||value.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>80))throw new Error('请选择最多12个标签，每个标签最多80字');
 return [...new Set(value.map(tag=>tag.trim()))];
}
export function trafficRowTags(row){return [...new Set([...(row.focused?[FOCUSED_TRAFFIC_TAG]:[]),...(row.tags||[]),...(row.tag?[row.tag]:[])])];}
