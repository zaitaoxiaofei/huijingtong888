import test from'node:test';import assert from'node:assert/strict';import{createWbVideoPlayer}from'../frontend/admin/utils/wb-video-player.js';
const element=(native=false)=>({src:'',pause(){},removeAttribute(){this.src='';},load(){},canPlayType(){return native?'maybe':'';}});
test('WB MP4 and native HLS playback do not load an unnecessary library',async()=>{let calls=0;const p=createWbVideoPlayer({loadHls:async()=>{calls++;throw Error();}}),mp4=element(),hls=element(true);await p.setSource(mp4,'https://example.test/video.mp4');await p.setSource(hls,'https://example.test/index.m3u8');assert.equal(mp4.src,'https://example.test/video.mp4');assert.equal(hls.src,'https://example.test/index.m3u8');assert.equal(calls,0);});
test('WB HLS attaches through the lazy player and is destroyed when its source changes',async()=>{const instances=[];class Hls{static isSupported(){return true;}static Events={ERROR:'error'};constructor(){instances.push(this);}on(){}loadSource(url){this.url=url;}attachMedia(video){this.video=video;}destroy(){this.destroyed=true;}}const video=element(),p=createWbVideoPlayer({loadHls:async()=>({default:Hls})});await p.setSource(video,'https://example.test/index.m3u8?version=1');assert.equal(instances[0].video,video);await p.setSource(video,'https://example.test/other.mp4');assert.equal(instances[0].destroyed,true);p.stop();});
test('a stale HLS import cannot attach after switching to another source or closing',async()=>{let resolve,created=0;class Hls{static isSupported(){return true;}constructor(){created++;}}const p=createWbVideoPlayer({loadHls:()=>new Promise(r=>resolve=r)}),video=element(),pending=p.setSource(video,'https://example.test/index.m3u8');await p.setSource(video,'https://example.test/current.mp4');resolve({default:Hls});await pending;assert.equal(created,0);assert.equal(video.src,'https://example.test/current.mp4');});

test('HLS segments wait for play and a stopped player cannot start downloading',async()=>{
 const instances=[],listeners=new Map();
 class Hls{static isSupported(){return true;}static Events={ERROR:'error'};constructor(options){this.options=options;this.starts=0;instances.push(this);}on(){}loadSource(){}attachMedia(){}startLoad(){this.starts++;}destroy(){this.destroyed=true;}}
 const video={...element(),paused:true,addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
 const player=createWbVideoPlayer({loadHls:async()=>({default:Hls})});
 await player.setSource(video,'https://example.test/video.m3u8');
 assert.equal(instances[0].options.autoStartLoad,false);assert.equal(instances[0].starts,0);
 listeners.get('play')();assert.equal(instances[0].starts,1);
 await player.setSource(video,'https://example.test/next.m3u8');
 const stale=listeners.get('play');player.stop();stale();
 assert.equal(instances[1].starts,0);assert.equal(instances[1].destroyed,true);assert.equal(listeners.size,0);
});
