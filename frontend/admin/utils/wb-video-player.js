// HLS is used by WB's returned video URLs. Keep playback scoped to WB and lazy.
export function createWbVideoPlayer({loadHls=()=>import('hls.js'),onError=()=>{}}={}){
 let player=null,generation=0;
 function stop(){generation++;player?.destroy();player=null;}
 async function setSource(video,url){stop();const current=generation;video.pause();video.removeAttribute('src');video.load();if(!url)return;
  if(!/^https?:\/\//i.test(url)){onError('视频地址无效，请重新核对。');return;}
  if(!/\.m3u8(?:[?#]|$)/i.test(url)||video.canPlayType('application/vnd.apple.mpegurl')){video.src=url;return;}
  try{const{default:Hls}=await loadHls();if(current!==generation)return;if(!Hls.isSupported()){onError('当前浏览器不支持此视频格式，请在 WB 后台核对。');return;}
   player=new Hls({enableWorker:false});player.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal&&current===generation){onError('视频暂时无法播放，请重试或在 WB 后台核对。');player?.destroy();player=null;}});player.loadSource(url);player.attachMedia(video);
  }catch{if(current===generation)onError('视频播放器加载失败，请重试。');}
 }
 return{setSource,stop};
}
