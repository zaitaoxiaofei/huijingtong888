<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Download, Refresh, VideoCamera } from "@element-plus/icons-vue";
import { getVideoGeneratorShops, withMediaToken } from "../../api/tools/productVideoGenerator";

const VIDEO_DURATION = 8;
const DEFAULT_BGM_URL = "/media/default-product-bgm.mp3";
const POSITION_OPTIONS = [
  { label: "左上角", value: "top-left" },
  { label: "右上角", value: "top-right" },
  { label: "左下角", value: "bottom-left" },
  { label: "右下角", value: "bottom-right" }
];
const MOTION_OPTIONS = [
  { label: "镜头推进", value: "zoom-in" },
  { label: "镜头拉远", value: "zoom-out" },
  { label: "轻微环绕", value: "orbit" },
  { label: "冲击震动", value: "impact" }
];
const EFFECT_OPTIONS = [
  { label: "亮光扫过", value: "shine" },
  { label: "主体聚光", value: "spotlight" },
  { label: "脉冲震感", value: "pulse" },
  { label: "亮光+震感", value: "shine-pulse" }
];
const MUSIC_OPTIONS = [
  { label: "默认BGM", value: "default" },
  { label: "关闭音乐", value: "none" },
  { label: "使用上传音乐", value: "uploaded" },
  { label: "内置动感节奏", value: "dynamic" },
  { label: "内置轻快展示", value: "bright" }
];

const form = reactive({
  motion: "impact",
  effect: "shine-pulse",
  logoPosition: "top-right",
  logoScale: 18,
  logoOpacity: 88,
  musicStyle: "default",
  musicVolume: 100
});

const shops = ref([]);
const selectedShopId = ref("");
const loadingShops = ref(false);
const generating = ref(false);
const mainImageFile = ref(null);
const logoFile = ref(null);
const musicFile = ref(null);
const musicFileName = ref("默认BGM");
const mainImageUrl = ref("");
const logoImageUrl = ref("");
const videoUrl = ref("");
const videoBlob = ref(null);
const videoName = ref("product-video.mp4");
const errorMessage = ref("");

const watermarkShops = computed(() => shops.value.filter((shop) => shop.status !== "deleted" && shop.watermark_path));
const selectedShop = computed(() => watermarkShops.value.find((shop) => String(shop.id) === String(selectedShopId.value)) || null);
const activeLogoUrl = computed(() => {
  if (logoImageUrl.value) return logoImageUrl.value;
  if (!selectedShop.value?.id) return "";
  return withMediaToken(`/api/tools/image-cropper/shop-watermark/${encodeURIComponent(selectedShop.value.id)}/file`);
});
const canGenerate = computed(() => Boolean(mainImageUrl.value) && !generating.value);
const musicEnabled = computed(() => form.musicStyle !== "none");

onMounted(loadShops);
onBeforeUnmount(() => {
  revokeUrl(mainImageUrl.value);
  revokeUrl(logoImageUrl.value);
  revokeUrl(videoUrl.value);
});

async function loadShops() {
  loadingShops.value = true;
  try {
    const payload = await getVideoGeneratorShops();
    shops.value = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
    if (!selectedShopId.value && watermarkShops.value[0]) selectedShopId.value = String(watermarkShops.value[0].id);
  } catch (error) {
    errorMessage.value = error.message || "店铺列表加载失败";
  } finally {
    loadingShops.value = false;
  }
}

function onMainImageChange(file) {
  const raw = file?.raw;
  if (!raw) return;
  revokeUrl(mainImageUrl.value);
  mainImageFile.value = raw;
  mainImageUrl.value = URL.createObjectURL(raw);
  clearVideo();
}

function onLogoChange(file) {
  const raw = file?.raw;
  if (!raw) return;
  revokeUrl(logoImageUrl.value);
  logoFile.value = raw;
  logoImageUrl.value = URL.createObjectURL(raw);
  selectedShopId.value = "";
  clearVideo();
}

function onMusicChange(file) {
  const raw = file?.raw;
  if (!raw) return;
  musicFile.value = raw;
  musicFileName.value = raw.name || "已上传音乐";
  form.musicStyle = "uploaded";
  clearVideo();
}

function clearMusic() {
  musicFile.value = null;
  musicFileName.value = "默认BGM";
  if (form.musicStyle === "uploaded") form.musicStyle = "default";
  clearVideo();
}

function clearLogo() {
  revokeUrl(logoImageUrl.value);
  logoFile.value = null;
  logoImageUrl.value = "";
}

function clearVideo() {
  revokeUrl(videoUrl.value);
  videoUrl.value = "";
  videoBlob.value = null;
}

async function generateVideo() {
  if (!mainImageUrl.value) {
    ElMessage.warning("请先上传主图");
    return;
  }

  generating.value = true;
  errorMessage.value = "";
  clearVideo();

  try {
    const image = await loadImage(mainImageUrl.value);
    const logo = activeLogoUrl.value ? await loadImage(activeLogoUrl.value).catch(() => null) : null;
    const blob = await renderVideo({ image, logo });
    videoBlob.value = blob;
    videoUrl.value = URL.createObjectURL(blob);
    videoName.value = buildVideoName(blob.type);
    ElMessage.success("视频已生成");
  } catch (error) {
    errorMessage.value = error.message || "视频生成失败";
  } finally {
    generating.value = false;
  }
}

async function renderVideo({ image, logo }) {
  const audioContext = musicEnabled.value ? await createMusicTrack(VIDEO_DURATION) : null;
  return new Promise((resolve, reject) => {
    const { width, height } = outputSize();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const fps = 30;
    const durationMs = VIDEO_DURATION * 1000;
    const stream = canvas.captureStream(fps);
    audioContext?.stream?.getAudioTracks().forEach((track) => stream.addTrack(track));
    const mimeType = chooseMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    let startedAt = 0;
    let frameId = 0;

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("浏览器录制视频失败"));
    recorder.onstop = () => {
      audioContext?.close?.();
      const outputMimeType = recorder.mimeType || mimeType || "video/webm";
      resolve(new Blob(chunks, { type: outputMimeType }));
    };

    function drawFrame(now) {
      if (!startedAt) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      drawCanvasFrame(ctx, width, height, image, logo, progress);
      if (progress < 1) {
        frameId = requestAnimationFrame(drawFrame);
      } else {
        window.setTimeout(() => recorder.state === "recording" && recorder.stop(), 120);
      }
    }

    recorder.start(250);
    frameId = requestAnimationFrame(drawFrame);
    window.setTimeout(() => {
      cancelAnimationFrame(frameId);
      if (recorder.state === "recording") recorder.stop();
    }, durationMs + 600);
  });
}

function drawCanvasFrame(ctx, width, height, image, logo, progress) {
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  const eased = easeInOut(progress);
  const cover = coverRect(image.width, image.height, width, height, motionScale(eased));
  const shift = motionShift(progress, width, height);
  ctx.drawImage(image, cover.x + shift.x, cover.y + shift.y, cover.width, cover.height);
  drawProductFocus(ctx, width, height, progress);
  drawCommercialEffect(ctx, width, height, progress);
  drawSoftVignette(ctx, width, height);
  if (logo) drawLogo(ctx, width, height, logo);
}

function drawProductFocus(ctx, width, height, progress) {
  if (form.effect !== "spotlight" && form.effect !== "shine-pulse") return;
  const pulse = 0.45 + Math.sin(progress * Math.PI * 6) * 0.08;
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.48, width * 0.08, width * 0.5, height * 0.48, width * pulse);
  gradient.addColorStop(0, "rgba(255,255,255,0.24)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.08)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawCommercialEffect(ctx, width, height, progress) {
  if (form.effect === "shine" || form.effect === "shine-pulse") {
    const sweep = ((progress * 1.35) % 1.15) - 0.25;
    ctx.save();
    ctx.translate(width * sweep, height * 0.48);
    ctx.rotate(-0.22);
    const gradient = ctx.createLinearGradient(-width * 0.08, 0, width * 0.16, 0);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.42)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(-width * 0.12, -height, width * 0.28, height * 2);
    ctx.restore();
  }

  if (form.effect === "pulse" || form.effect === "shine-pulse") {
    const beat = Math.max(0, Math.sin(progress * Math.PI * 10));
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.5, width * 0.18, width * 0.5, height * 0.5, width * (0.42 + beat * 0.08));
    gradient.addColorStop(0, `rgba(255,255,255,${0.14 * beat})`);
    gradient.addColorStop(0.55, `rgba(255,255,255,${0.05 * beat})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawLogo(ctx, width, height, logo) {
  const maxWidth = width * (Number(form.logoScale) / 100);
  const ratio = logo.height ? logo.width / logo.height : 1;
  const logoWidth = maxWidth;
  const logoHeight = logoWidth / ratio;
  const margin = Math.max(24, width * 0.04);
  const positions = {
    "top-left": { x: margin, y: margin },
    "top-right": { x: width - logoWidth - margin, y: margin },
    "bottom-left": { x: margin, y: height - logoHeight - margin },
    "bottom-right": { x: width - logoWidth - margin, y: height - logoHeight - margin }
  };
  const point = positions[form.logoPosition] || positions["top-right"];
  ctx.save();
  ctx.globalAlpha = Number(form.logoOpacity) / 100;
  ctx.drawImage(logo, point.x, point.y, logoWidth, logoHeight);
  ctx.restore();
}

async function createMusicTrack(duration) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  const context = new AudioCtx();
  const destination = context.createMediaStreamDestination();
  const master = context.createGain();
  master.gain.value = Number(form.musicVolume) / 100 * 0.22;
  master.connect(destination);

  if (form.musicStyle === "default") {
    await createAudioBufferMusic(context, master, duration, await fetchDefaultBgmBuffer());
    return { close: () => context.close(), stream: destination.stream };
  }

  if (form.musicStyle === "uploaded" && musicFile.value) {
    await createAudioBufferMusic(context, master, duration, await musicFile.value.arrayBuffer());
    return { close: () => context.close(), stream: destination.stream };
  }

  const preset = musicPreset(form.musicStyle);
  createBassLine(context, master, duration, preset);
  createLeadLine(context, master, duration, preset);
  createKickTrack(context, master, duration, preset);
  createHatTrack(context, master, duration, preset);

  return { close: () => context.close(), stream: destination.stream };
}

async function fetchDefaultBgmBuffer() {
  const response = await fetch(DEFAULT_BGM_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error("默认BGM加载失败");
  return response.arrayBuffer();
}

async function createAudioBufferMusic(context, master, duration, arrayBuffer) {
  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  let startAt = 0;
  while (startAt < duration) {
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(master);
    source.start(context.currentTime + startAt, 0, Math.min(audioBuffer.duration, duration - startAt));
    startAt += audioBuffer.duration;
  }
}

function musicPreset(style) {
  if (style === "tech") {
    return { bpm: 124, lead: "square", bass: "sawtooth", notes: [392, 493.88, 587.33, 659.25], bassNotes: [98, 98, 123.47, 146.83] };
  }
  if (style === "bright") {
    return { bpm: 116, lead: "triangle", bass: "sine", notes: [523.25, 659.25, 783.99, 880], bassNotes: [130.81, 146.83, 164.81, 196] };
  }
  return { bpm: 124, lead: "triangle", bass: "sine", notes: [440, 554.37, 659.25, 739.99], bassNotes: [110, 110, 138.59, 164.81] };
}

function createBassLine(context, master, duration, preset) {
  const beat = 60 / preset.bpm;
  for (let t = 0; t < duration; t += beat) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = preset.bass;
    osc.frequency.value = preset.bassNotes[Math.floor(t / beat) % preset.bassNotes.length];
    gain.gain.setValueAtTime(0.0001, context.currentTime + t);
    gain.gain.exponentialRampToValueAtTime(0.55, context.currentTime + t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + t + beat * 0.7);
    osc.connect(gain).connect(master);
    osc.start(context.currentTime + t);
    osc.stop(context.currentTime + t + beat * 0.75);
  }
}

function createLeadLine(context, master, duration, preset) {
  const step = 60 / preset.bpm / 2;
  for (let t = 0; t < duration; t += step * 2) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = preset.lead;
    osc.frequency.value = preset.notes[Math.floor(t / step) % preset.notes.length];
    gain.gain.setValueAtTime(0.0001, context.currentTime + t);
    gain.gain.exponentialRampToValueAtTime(0.24, context.currentTime + t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + t + step * 1.2);
    osc.connect(gain).connect(master);
    osc.start(context.currentTime + t);
    osc.stop(context.currentTime + t + step * 1.25);
  }
}

function createKickTrack(context, master, duration, preset) {
  const beat = 60 / preset.bpm;
  for (let t = 0; t < duration; t += beat) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130, context.currentTime + t);
    osc.frequency.exponentialRampToValueAtTime(46, context.currentTime + t + 0.12);
    gain.gain.setValueAtTime(0.9, context.currentTime + t);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + t + 0.16);
    osc.connect(gain).connect(master);
    osc.start(context.currentTime + t);
    osc.stop(context.currentTime + t + 0.18);
  }
}

function createHatTrack(context, master, duration, preset) {
  const step = 60 / preset.bpm / 2;
  for (let t = step; t < duration; t += step) {
    const buffer = context.createBuffer(1, context.sampleRate * 0.035, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    noise.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = 5200;
    gain.gain.value = 0.12;
    noise.connect(filter).connect(gain).connect(master);
    noise.start(context.currentTime + t);
  }
}

function outputSize() {
  return { width: 900, height: 1200 };
}

function coverRect(sourceWidth, sourceHeight, targetWidth, targetHeight, extraScale = 1) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * extraScale;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height
  };
}

function motionScale(progress) {
  if (form.motion === "zoom-out") return 1.12 - progress * 0.07;
  if (form.motion === "orbit") return 1.08 + Math.sin(progress * Math.PI * 2) * 0.012;
  if (form.motion === "impact") return 1.04 + Math.max(0, Math.sin(progress * Math.PI * 10)) * 0.018 + progress * 0.035;
  return 1.03 + progress * 0.065;
}

function motionShift(progress, width, height) {
  if (form.motion === "orbit") {
    return {
      x: Math.sin(progress * Math.PI * 2) * width * 0.018,
      y: Math.cos(progress * Math.PI * 2) * height * 0.012
    };
  }
  if (form.motion === "impact") {
    const hit = Math.sin(progress * Math.PI * 12);
    return {
      x: hit * width * 0.004,
      y: Math.cos(progress * Math.PI * 10) * height * 0.003
    };
  }
  return { x: 0, y: 0 };
}

function drawSoftVignette(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255,255,255,0.10)");
  gradient.addColorStop(0.52, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "rgba(15,23,42,0.10)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

function chooseMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((item) => MediaRecorder.isTypeSupported(item)) || "";
}

function buildVideoName(mimeType = "") {
  const base = (mainImageFile.value?.name || "product-main").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  const shop = selectedShop.value?.name ? `-${selectedShop.value.name.replace(/[^\w.-]+/g, "-")}` : "";
  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return `${base}${shop}-video.${ext}`;
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function revokeUrl(url) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}
</script>

<template>
  <section class="product-video-page">
    <header class="page-header">
      <div>
        <h1>一键生成视频</h1>
        <p>固定 3:4、8 秒成片，主图加镜头运动、电商亮光特效、店铺 logo 和默认背景音乐。</p>
      </div>
      <el-button :icon="Refresh" :loading="loadingShops" @click="loadShops">刷新店铺</el-button>
    </header>

    <el-alert
      v-if="errorMessage"
      type="error"
      show-icon
      :closable="true"
      :title="errorMessage"
      @close="errorMessage = ''"
    />

    <div class="workspace">
      <el-card class="panel control-panel" shadow="never">
        <template #header><span>生成设置</span></template>
        <el-form label-position="top">
          <el-form-item label="主图">
            <el-upload
              class="main-image-uploader"
              drag
              accept="image/png,image/jpeg,image/webp"
              :auto-upload="false"
              :show-file-list="false"
              :on-change="onMainImageChange"
            >
              <div v-if="mainImageUrl" class="main-image-preview">
                <img :src="mainImageUrl" alt="主图预览">
                <img v-if="activeLogoUrl" class="logo-preview" :class="form.logoPosition" :src="activeLogoUrl" alt="logo 预览">
                <span class="replace-image-hint">重新上传</span>
              </div>
              <div v-else class="upload-placeholder">
                <el-icon><VideoCamera /></el-icon>
                <span>点击或拖拽上传产品主图</span>
              </div>
            </el-upload>
          </el-form-item>

          <div class="fixed-info">
            <span>画面比例：3:4</span>
            <span>视频长度：8 秒</span>
          </div>

          <div class="form-grid">
            <el-form-item label="镜头运动">
              <el-select v-model="form.motion">
                <el-option v-for="item in MOTION_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="电商特效">
              <el-select v-model="form.effect">
                <el-option v-for="item in EFFECT_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="店铺 logo 水印">
            <el-select v-model="selectedShopId" clearable filterable placeholder="选择店铺水印">
              <el-option
                v-for="shop in watermarkShops"
                :key="shop.id"
                :label="shop.name || `店铺 ${shop.id}`"
                :value="String(shop.id)"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="或上传临时 logo">
            <div class="logo-row">
              <el-upload
                accept="image/png,image/jpeg,image/webp"
                :auto-upload="false"
                :show-file-list="false"
                :on-change="onLogoChange"
              >
                <el-button>上传 logo</el-button>
              </el-upload>
              <el-button :disabled="!logoImageUrl" @click="clearLogo">清除</el-button>
              <el-select v-model="form.logoPosition" class="logo-position-select">
                <el-option v-for="item in POSITION_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </div>
          </el-form-item>

          <div class="form-grid">
            <el-form-item label="logo 大小">
              <el-slider v-model="form.logoScale" :min="8" :max="32" />
            </el-form-item>
            <el-form-item label="logo 透明度">
              <el-slider v-model="form.logoOpacity" :min="30" :max="100" />
            </el-form-item>
          </div>

          <el-form-item label="背景音乐">
            <el-select v-model="form.musicStyle">
              <el-option v-for="item in MUSIC_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>

          <el-form-item label="上传背景音乐">
            <div class="music-row">
              <el-upload
                accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/mp4,audio/aac"
                :auto-upload="false"
                :show-file-list="false"
                :on-change="onMusicChange"
              >
                <el-button>选择音乐文件</el-button>
              </el-upload>
              <span class="music-name">{{ musicFileName || "未上传" }}</span>
              <el-button :disabled="!musicFile" @click="clearMusic">清除</el-button>
            </div>
          </el-form-item>

          <el-form-item v-if="musicEnabled" label="音乐音量">
            <el-slider v-model="form.musicVolume" :min="0" :max="100" />
          </el-form-item>

          <div class="actions">
            <el-button type="primary" :icon="VideoCamera" :loading="generating" :disabled="!canGenerate" @click="generateVideo">
              生成视频
            </el-button>
            <el-button
              :icon="Download"
              :disabled="!videoUrl"
              tag="a"
              :href="videoUrl || undefined"
              :download="videoName"
            >
              下载视频
            </el-button>
          </div>
        </el-form>
      </el-card>

      <el-card class="panel preview-panel" shadow="never">
        <template #header><span>视频预览</span></template>
        <div class="video-stage">
          <el-empty v-if="!videoUrl" description="生成后在这里预览视频" />
          <video v-else :src="videoUrl" controls playsinline />
        </div>
        <div v-if="videoUrl" class="result-meta">
          <strong>{{ videoName }}</strong>
          <span>3:4 · 8 秒 · {{ musicEnabled ? MUSIC_OPTIONS.find((item) => item.value === form.musicStyle)?.label : "无音乐" }}</span>
        </div>
      </el-card>
    </div>
  </section>
</template>

<style scoped>
.product-video-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.page-header h1 {
  margin: 0;
  color: var(--erp-text);
  font-size: 24px;
}

.page-header p {
  margin: 6px 0 0;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(380px, 460px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.panel {
  border: 1px solid var(--erp-border);
  border-radius: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.main-image-uploader :deep(.el-upload),
.main-image-uploader :deep(.el-upload-dragger) {
  width: 100%;
}

.main-image-uploader :deep(.el-upload-dragger) {
  padding: 0;
  overflow: hidden;
  border-radius: 8px;
}

.main-image-preview,
.upload-placeholder {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  background: #f8fafc;
}

.upload-placeholder {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.upload-placeholder :deep(.el-icon) {
  margin-bottom: 8px;
  font-size: 28px;
}

.main-image-preview > img:first-child {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.replace-image-hint {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.72);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  pointer-events: none;
}

.fixed-info {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.fixed-info span {
  padding: 6px 10px;
  border: 1px solid var(--erp-border);
  border-radius: 6px;
  background: var(--erp-surface-alt);
}

.logo-row,
.music-row,
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.music-name {
  max-width: 180px;
  overflow: hidden;
  color: var(--erp-text-secondary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logo-position-select {
  width: 132px;
}

.logo-preview {
  position: absolute;
  width: 18%;
  max-height: 18%;
  object-fit: contain;
  opacity: 0.88;
}

.logo-preview.top-left { top: 4%; left: 4%; }
.logo-preview.top-right { top: 4%; right: 4%; }
.logo-preview.bottom-left { bottom: 4%; left: 4%; }
.logo-preview.bottom-right { right: 4%; bottom: 4%; }

.video-stage {
  display: grid;
  min-height: 620px;
  place-items: center;
  border: 1px dashed var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface-alt);
  overflow: hidden;
}

.video-stage video {
  width: min(100%, 540px);
  aspect-ratio: 3 / 4;
  max-height: 720px;
  border-radius: 8px;
  background: #0f172a;
}

.result-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.result-meta strong {
  color: var(--erp-text);
}

@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .page-header,
  .result-meta {
    align-items: flex-start;
    flex-direction: column;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .video-stage {
    min-height: 460px;
  }
}
</style>
