import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryScanCrop} from '../frontend/admin/utils/inventory-scan-frame.js';

test('portrait camera is center-cropped to the horizontal viewfinder without stretching',()=>{
 assert.deepEqual(inventoryScanCrop(720,1280,320,180),{x:0,y:437.5,width:720,height:405});
 assert.deepEqual(inventoryScanCrop(1280,720,320,180),{x:0,y:0,width:1280,height:720});
 assert.deepEqual(inventoryScanCrop(1920,720,320,180),{x:320,y:0,width:1280,height:720});
 assert.deepEqual(inventoryScanCrop(1024,1024,400,200),{x:0,y:256,width:1024,height:512});
});
test('unready video and hidden frame never produce an invalid decoding canvas',()=>{
 for(const values of [[0,1280,320,180],[720,0,320,180],[720,1280,0,180],[720,1280,320,0],[NaN,1280,320,180]])assert.equal(inventoryScanCrop(...values),null);
});
