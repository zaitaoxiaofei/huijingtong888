<script>
import { defineAsyncComponent, h } from "vue";

const WORKBENCH_STORAGE_PREFIXES = [
  "ozon-ai-product-variant-workbench-draft:",
  "ozon-ai-optimization-workbench-v2-draft:"
];

purgeStaleWorkbenchCache();

const runtimeAsset = "/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js?v=codex-ai-variant-force-variant-20260613";
const AiOptimizationWorkbenchRuntime = defineAsyncComponent(() =>
  import(/* @vite-ignore */ runtimeAsset)
);

function purgeStaleWorkbenchCache() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search || "");
  const explicitWorkbenchId = String(params.get("workbenchId") || "").trim();
  const allowedKeys = explicitWorkbenchId
    ? new Set(WORKBENCH_STORAGE_PREFIXES.map((prefix) => `${prefix}${explicitWorkbenchId}`))
    : new Set();
  try {
    const keys = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && WORKBENCH_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) {
      if (!allowedKeys.has(key)) window.sessionStorage.removeItem(key);
    }
    for (const prefix of WORKBENCH_STORAGE_PREFIXES) {
      window.sessionStorage.removeItem(`${prefix}__latest`);
    }
  } catch {
    // Ignore storage errors; stale cache cleanup is best-effort.
  }
}

export default {
  name: "AiOptimizationWorkbenchV2",
  setup() {
    return () => h(AiOptimizationWorkbenchRuntime);
  }
};
</script>

<style>
/* ai variant result layout polish */
.ai-opt-page[data-v-750c83a9] {
  padding: 14px 16px 18px;
  gap: 10px;
  background: #eef3f8;
}

.result-stage[data-v-750c83a9] {
  padding: 14px 10px 10px;
  overflow: hidden;
}

.worktable-head[data-v-750c83a9] {
  align-items: center;
  gap: 14px;
  padding: 0 0 12px;
}

.result-tools[data-v-750c83a9] {
  min-width: 0;
  justify-content: flex-end;
  row-gap: 8px;
}

.result-tools[data-v-750c83a9] .el-button {
  margin-left: 0;
}

.variant-result-table-wrap[data-v-750c83a9] {
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #fff;
  overflow: auto;
}

.variant-result-table[data-v-750c83a9] {
  width: 100%;
  min-width: 1480px;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}

.variant-result-table[data-v-750c83a9] th {
  height: 38px;
  padding: 8px 10px;
  color: #475569;
  font-size: 12px;
  font-weight: 800;
  text-align: left;
  background: #f8fafc;
  border-bottom: 1px solid #dbe5ef;
}

.variant-result-table[data-v-750c83a9] td {
  height: 112px;
  padding: 10px;
  vertical-align: top;
  border-bottom: 1px solid #edf2f7;
}

.variant-result-table[data-v-750c83a9] tbody tr:hover td {
  background: #f8fbff;
}

.variant-result-target[data-v-750c83a9] {
  width: 240px;
}

.variant-main-image-head[data-v-750c83a9],
.variant-image-cell[data-v-750c83a9] {
  width: 96px;
}

.variant-detail-head[data-v-750c83a9],
.variant-detail-cell[data-v-750c83a9] {
  width: 128px;
}

.variant-title-head[data-v-750c83a9],
.title-cell[data-v-750c83a9] {
  width: 190px;
}

.variant-tags-head[data-v-750c83a9],
.variant-tags-cell[data-v-750c83a9] {
  width: 170px;
}

.variant-description-head[data-v-750c83a9],
.desc-cell[data-v-750c83a9],
.variant-richtext-head[data-v-750c83a9],
.richtext-cell[data-v-750c83a9] {
  width: 220px;
}

.variant-video-head[data-v-750c83a9],
.variant-video-cell[data-v-750c83a9] {
  width: 178px;
}

.variant-action-cell[data-v-750c83a9] {
  width: 260px;
  min-width: 260px;
}

.target-cell[data-v-750c83a9] {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
}

.target-cell[data-v-750c83a9] strong,
.variant-text-cell[data-v-750c83a9] p,
.variant-tags-cell[data-v-750c83a9] {
  overflow-wrap: anywhere;
}

.variant-text-cell[data-v-750c83a9] p {
  max-height: 66px;
  margin: 0;
  color: #334155;
  line-height: 1.45;
  overflow: auto;
}

.richtext-cell[data-v-750c83a9] p {
  display: block;
  max-height: 66px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #334155;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  overflow: auto;
  white-space: normal;
}

.variant-text-cell[data-v-750c83a9] p:only-child,
.variant-tags-cell[data-v-750c83a9]:empty {
  color: #94a3b8;
}

.table-tag-row[data-v-750c83a9] {
  max-height: 68px;
  overflow: auto;
}

.table-video-preview[data-v-750c83a9] {
  width: 154px;
  justify-items: stretch;
  cursor: pointer;
}

.table-video-preview video[data-v-750c83a9],
.table-video-placeholder[data-v-750c83a9] {
  width: 154px;
  height: 76px;
  border-radius: 7px;
}

.table-video-preview strong[data-v-750c83a9] {
  display: block;
  max-width: 154px;
  min-height: 18px;
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-video-preview.generating[data-v-750c83a9] strong {
  color: #b45309;
}

.table-video-preview:not(.ready):not(.generating)[data-v-750c83a9] strong {
  color: #dc2626;
}

.variant-status-cell[data-v-750c83a9] {
  width: 108px;
}

.variant-action-cell[data-v-750c83a9] {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-content: start;
  gap: 6px;
}

.variant-action-cell[data-v-750c83a9] .el-button {
  width: 100%;
  margin-left: 0;
  min-height: 26px;
  padding-inline: 6px;
  justify-content: center;
  overflow: hidden;
}

.variant-action-cell[data-v-750c83a9] .el-button > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variant-action-cell[data-v-750c83a9] .el-button + .el-button {
  margin-left: 0;
}

.video-preview[data-v-750c83a9] video {
  width: 100%;
  max-height: 68vh;
  object-fit: contain;
  background: #0f172a;
  border-radius: 8px;
}

@media (max-width: 1280px) {
  .worktable-head[data-v-750c83a9] {
    display: grid;
  }

  .result-tools[data-v-750c83a9] {
    justify-content: flex-start;
  }
}
</style>
