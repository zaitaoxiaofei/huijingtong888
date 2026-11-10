// Per-process slots only coordinate orchestration; SQL leases protect each job
// across processes and the AI runtime pool still limits actual supplier calls.
export function createWorkflowJobPump(runNext, requested=3) {
  const limit=Math.max(1,Math.min(8,Number.parseInt(requested,10)||3)),active=new Set();
  return async function tick(){
    const started=[];
    while(active.size<limit){
      const task=Promise.resolve().then(runNext).finally(()=>active.delete(task));
      active.add(task);started.push(task);
    }
    return Promise.allSettled(started);
  };
}
