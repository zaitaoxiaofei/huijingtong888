const STAGE='generated_image_v1';
export function generatedImageCheckpoint(saved){
  return saved?.stage===STAGE&&Array.isArray(saved.result?.generatedImages)&&saved.result.generatedImages.length?saved.result:null;
}
export async function completeCheckpointedImage(input,{generate,persist,checkpoint}) {
  const saved=generatedImageCheckpoint(input.generatedCheckpoint);
  const output=saved||await generate(input);
  try {
    if(!saved)await checkpoint({stage:STAGE,result:output});
    return await persist(output,input);
  }catch(cause){
    throw Object.assign(new Error('图片已生成，正在等待素材保存恢复；将复用原图，不重新调用生图。',{cause}),{code:'AI_GENERATION_STORAGE_PENDING',status:503});
  }
}
