export function sellerAnalyticsPluginResultResponse(result, compact = false) {
  if (!compact || result?.run?.daily_traffic !== true) return {success:true,data:result,...result};
  const {run,request} = result;
  return {success:true,data:{
    run:{id:run.id,status:run.status,completed_count:run.completed_count,failed_count:run.failed_count,request_count:run.request_count},
    request:{id:request?.id,status:request?.status},
    metricCount:Number(result.metricCount || 0)
  }};
}
