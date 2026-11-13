export const wbPublishStatus = status => ({queued:'等待发布',processing:'处理中',needs_review:'需核对',paused:'已暂停',failed:'提交失败',completed:'已完成',superseded:'已由后续操作接替'}[status]||status||'未知');
export const wbPublishPhase = phase => ({archive:'移入 WB 回收站',recover:'恢复原商品',update:'更新商品内容',card:'创建商品卡',media:'上传图片与视频',price:'设置价格',done:'已确认'}[phase]||phase||'等待处理');
