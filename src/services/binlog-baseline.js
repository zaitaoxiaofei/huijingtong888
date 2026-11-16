import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyPrivateObject} from './verified-private-object.js';

// The baseline manifest is an operator-reviewed, immutable recovery attestation,
// not a switch inferred from the presence of an old local .sql.gz file.
export async function verifyBinlogBaseline({client,key,uuid,database,logs,previous}){
 const prefix=`database-archives/mysql-baselines/${uuid}/`,match=/\/([a-f0-9]{64})\.json$/.exec(key||'');if(!match||key!==prefix+'manifests/'+match[1]+'.json')throw Error('Reviewed private full-database recovery baseline required');
 const response=await client.getStream(key),chunks=[];let bytes=0;try{for await(const chunk of response.stream){bytes+=chunk.length;if(bytes>65536)throw Error('Recovery baseline manifest exceeds bound');chunks.push(chunk);}}finally{response.stream.destroy?.();}
 const body=Buffer.concat(chunks),sha256=crypto.createHash('sha256').update(body).digest('hex');assert(key.endsWith('/'+sha256+'.json'),'Baseline manifest checksum mismatch');await verifyPrivateObject(client,key,{bytes,sha256});const manifest=JSON.parse(body.toString('utf8'));
 if(manifest.format!=='verified-full-database-baseline-v1'||manifest.uuid!==uuid||manifest.database!==database||manifest.restore_verified!==true||!Number.isFinite(Date.parse(manifest.verified_at))||!/^binlog\.[0-9]{6,12}$/.test(manifest.binlog_file||'')||!Number.isSafeInteger(manifest.binlog_position)||manifest.binlog_position<4)throw Error('Unverified or wrong-database recovery baseline');
 const backup=manifest.backup;if(!backup||!/^[a-f0-9]{64}$/.test(backup.sha256||'')||!Number.isSafeInteger(backup.bytes)||backup.bytes<1||backup.bytes>8*1024**3||backup.object_key!==prefix+backup.sha256+'.sql.gz')throw Error('Invalid private recovery baseline backup');
 const local=logs.find(r=>r.Log_name===manifest.binlog_file);if(local&&manifest.binlog_position>Number(local.File_size))throw Error('Baseline position exceeds its log');
 if(previous?.manifest_key!==key&&!logs.some(r=>r.Log_name===manifest.binlog_file))throw Error('Baseline log is no longer local; archive continuity must be reviewed before activation');
 // Read the complete compressed backup, not merely its HEAD/ETag. Streaming
 // bounds memory even when the verified database backup is several GiB.
 await verifyPrivateObject(client,backup.object_key,backup);
 return {manifest_key:key,manifest_sha256:sha256,backup,binlog_file:manifest.binlog_file,binlog_position:manifest.binlog_position,verified_at:manifest.verified_at};
}
