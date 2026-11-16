import {spawn} from 'node:child_process';
import path from 'node:path';

export async function verifyMysqlBinlog(file,{binary='/usr/bin/mysqlbinlog'}={}){
 if(!path.isAbsolute(binary)||!path.isAbsolute(file))throw Error('Absolute binlog validator paths required');
 await new Promise((resolve,reject)=>{const child=spawn(binary,['--no-defaults','--verify-binlog-checksum','--base64-output=DECODE-ROWS',file],{stdio:['ignore','ignore','pipe']});let error='';const timer=setTimeout(()=>{child.kill('SIGTERM');},120000);child.stderr.on('data',chunk=>{if(error.length<8192)error+=chunk;});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('MySQL binlog checksum validation failed: '+error.slice(0,1000)));});});
}
