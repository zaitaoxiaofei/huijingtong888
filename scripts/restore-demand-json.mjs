import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {restoreDemandSnapshotObject} from '../src/services/inventory-demand-object-recovery.js';
import {verifyAiMediaRetentionMaintenance} from './cleanup-ai-media-retention.mjs';

export async function restoreDemandJson(args){
 const options=new Map();for(const arg of args){const m=/^--(database|socket|tenant|offline-maintenance|write)(?:=(.*))?$/.exec(arg);if(!m||options.has(m[1])||(['write','offline-maintenance'].includes(m[1])?m[2]!==undefined:!m[2]))throw Error('Invalid rollback options');options.set(m[1],m[2]??true);}
 if(!/^\w{1,64}$/.test(options.get('database')||'')||!String(options.get('socket')||'').startsWith('/')||!/^[1-9][0-9]*$/.test(options.get('tenant')||''))throw Error('Explicit database, administrator socket and enterprise required');
 if(!options.has('write')||!options.has('offline-maintenance')||process.env.LARGE_OBJECT_STORAGE_ENABLED==='1')throw Error('Disable large-object writers and explicitly approve offline rollback');
 const {default:mysql}=await import('mysql2/promise'),db=await mysql.createConnection({user:'root',socketPath:options.get('socket'),database:options.get('database'),dateStrings:true});const query=async(sql,p=[])=>(await db.query(sql,p))[0];
 try{await verifyAiMediaRetentionMaintenance({query});return await restoreDemandSnapshotObject({query,tenantId:Number(options.get('tenant'))});}finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)restoreDemandJson(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
