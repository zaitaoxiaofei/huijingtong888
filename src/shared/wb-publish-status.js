export const wbPublishStatus = status => ({queued:'等待发布',processing:'处理中',needs_review:'需核对',paused:'已暂停',failed:'提交失败',completed:'发布完成'}[status]||status||'未知');
export const wbPublishPhase = phase => ({card:'创建商品卡',media:'上传图片与视频',price:'设置价格',done:'已确认'}[phase]||phase||'等待处理');
