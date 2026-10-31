// Short-lived, session-scoped page results. Purchasing always rechecks live data.
export function createInventoryWorkspacePageCache({now=Date.now,ttl=20000,max=6}={}) {
  const pages=new Map();
  const key=(scope,url)=>JSON.stringify([scope,url]);
  return {
    get(scope,url){const k=key(scope,url),entry=pages.get(k);if(!entry)return null;if(entry.expires<=now()){pages.delete(k);return null;}return entry.value;},
    set(scope,url,value){const k=key(scope,url);pages.delete(k);pages.set(k,{value,expires:now()+ttl});while(pages.size>max)pages.delete(pages.keys().next().value);},
    clear(){pages.clear();}
  };
}
