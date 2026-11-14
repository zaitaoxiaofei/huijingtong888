<script setup>
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import MobileDialog from './MobileDialog.vue';
import {inventoryScanCrop} from '../../utils/inventory-scan-frame.js';
const props=defineProps({modelValue:Boolean});
const emit=defineEmits(['update:modelValue','scanned']);
const visible=computed({get:()=>props.modelValue,set:value=>emit('update:modelValue',value)});
const video=ref(null),frame=ref(null),error=ref(''),starting=ref(false);
let stream,reader,timer,version=0;
function stop(){++version;clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;reader?.reset();reader=null;if(video.value)video.value.srcObject=null;starting.value=false;}
function cameraError(e){
 if(['NotAllowedError','PermissionDeniedError'].includes(e?.name))return '未获得摄像头权限，请在浏览器的网站设置中允许使用摄像头后重试。';
 if(['NotFoundError','DevicesNotFoundError'].includes(e?.name))return '没有找到可用摄像头，请使用带摄像头的手机打开此页面。';
 if(['NotReadableError','TrackStartError'].includes(e?.name))return '摄像头暂时无法使用，请关闭其他占用摄像头的应用后重试。';
 return '无法启动摄像头，请使用手机系统浏览器打开 HTTPS 网站后重试，也可关闭后手动输入库存 ID。';
}
async function start(){
 stop();error.value='';starting.value=true;const token=version;
 try{
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('camera unavailable');
  const {MultiFormatReader,BinaryBitmap,HybridBinarizer,RGBLuminanceSource,BarcodeFormat,DecodeHintType,NotFoundException,ChecksumException,FormatException}=await import('@zxing/library');
  if(token!==version||!props.modelValue)return;
  reader=new MultiFormatReader();reader.setHints(new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.CODE_128]],[DecodeHintType.TRY_HARDER,true]]));
  const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
  if(token!==version||!props.modelValue){acquired.getTracks().forEach(track=>track.stop());return;}
  stream=acquired;await nextTick();if(token!==version)return;
  video.value.muted=true;video.value.srcObject=stream;await video.value.play();if(token!==version)return;
  starting.value=false;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const scan=()=>{
   if(token!==version||!props.modelValue)return;
   if(video.value?.readyState>=2){
    try{
     const crop=inventoryScanCrop(video.value.videoWidth,video.value.videoHeight,frame.value?.clientWidth,frame.value?.clientHeight);
     if(!crop){timer=setTimeout(scan,180);return;}
     canvas.width=Math.round(crop.width);canvas.height=Math.round(crop.height);
     ctx.drawImage(video.value,crop.x,crop.y,crop.width,crop.height,0,0,canvas.width,canvas.height);
     const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,gray=new Uint8ClampedArray(canvas.width*canvas.height);
     for(let i=0;i<gray.length;i++)gray[i]=(pixels[i*4]*306+pixels[i*4+1]*601+pixels[i*4+2]*117+512)>>10;
     const number=reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray,canvas.width,canvas.height)))).getText().trim();
     if(number){stop();emit('scanned',number);visible.value=false;return;}
    }
    catch(e){if(!(e instanceof NotFoundException||e instanceof ChecksumException||e instanceof FormatException)){stop();error.value='条形码识别暂时失败，请重试并将完整条形码放入画面。';return;}}
   }
   timer=setTimeout(scan,180);
  };scan();
 }catch(e){if(token!==version)return;stop();error.value=cameraError(e);}
}
function hidden(){if(document.hidden){stop();visible.value=false;}}
function scopeChanged(){stop();visible.value=false;}
watch(()=>props.modelValue,value=>{if(!value)stop();},{flush:'sync'});
onMounted(()=>{document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',scopeChanged);window.addEventListener('erp:auth-scope-changed',scopeChanged);if(props.modelValue)start();});
onBeforeUnmount(()=>{stop();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',scopeChanged);window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <MobileDialog v-model="visible" title="扫一扫库存标签" class="mobile-inventory-scanner">
  <p>手机保持竖屏，将完整条形码横向放入绿色取景框，识别后自动显示对应库存和商品图片。</p>
  <div ref="frame" class="inventory-scan-frame"><video ref="video" autoplay muted playsinline aria-label="库存条形码摄像头画面"/><div class="inventory-scan-guide" aria-hidden="true"><span/></div></div>
  <p v-if="starting" role="status">正在打开摄像头，请允许摄像头权限…</p>
  <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
  <p v-else-if="!starting" role="status">对准条形码，保持清晰并稍作停留。</p>
  <template #footer><el-button @click="visible=false">关闭</el-button><el-button v-if="error" type="primary" @click="start">重试摄像头</el-button></template>
 </MobileDialog>
</template>
<style scoped>
.inventory-scan-frame{position:relative;width:100%;aspect-ratio:16/9;max-height:50dvh;overflow:hidden;background:#111;border-radius:8px}.inventory-scan-frame video{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}.inventory-scan-guide{position:absolute;inset:0;border:2px solid #22c55e;border-radius:8px;pointer-events:none}.inventory-scan-guide span{position:absolute;left:7%;right:7%;top:50%;height:2px;background:#22c55e;box-shadow:0 0 8px #22c55e}.mobile-inventory-scanner p{font-size:14px;line-height:1.6}
</style>
