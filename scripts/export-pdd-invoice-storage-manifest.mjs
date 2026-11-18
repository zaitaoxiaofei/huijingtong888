import fs from 'node:fs/promises';
import path from 'node:path';
import {mysqlQuery,closeMysqlPool} from '../src/mysql-pool.js';
import {pddInvoiceStorageManifest} from './lib/pdd-invoice-storage-manifest.mjs';
const args=process.argv.slice(2),value=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
if(args.some(a=>!/^--(?:tenant-id|output)=.+$/.test(a))||new Set(args.map(a=>a.split('=')[0])).size!==args.length)throw Error('Only --tenant-id and --output are supported');
const tenant=Number(value('--tenant-id')),output=value('--output');
if(!Number.isSafeInteger(tenant)||tenant<=0||!output)throw Error('Provide an explicit --tenant-id and private --output file');
try{
 const rows=await mysqlQuery('SELECT tenant_id,account_id,revision,payload_json FROM pdd_invoice_accounts WHERE tenant_id=? ORDER BY account_id',[tenant]);
 const report=pddInvoiceStorageManifest(rows,tenant),filename=path.resolve(output);
 await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({tenantId:tenant,accounts:report.accountCount,files:report.fileCount,output:filename,readOnly:true}));
}finally{await closeMysqlPool();}
