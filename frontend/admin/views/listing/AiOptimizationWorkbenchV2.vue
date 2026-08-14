<script>
import { defineAsyncComponent, h } from "vue";

const WORKBENCH_STORAGE_PREFIXES = [
  "ozon-ai-product-variant-workbench-draft:",
  "ozon-ai-optimization-workbench-v2-draft:"
];

purgeStaleWorkbenchCache();

const runtimeAsset = "/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js?v=codex-variant-stylefix-20260624";
const AiOptimizationWorkbenchRuntime = defineAsyncComponent(() => import(/* @vite-ignore */ runtimeAsset));

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
/* ai variant workbench base layout */
.ai-opt-page[data-v-750c83a9] {
  display: grid;
  gap: 12px;
  padding: 14px 16px 18px;
  background: #eef3f8;
}

.ai-opt-page[data-v-750c83a9] .panel {
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #fff;
}

.topbar[data-v-750c83a9] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #fff;
}

.title-block[data-v-750c83a9] {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.title-block[data-v-750c83a9] span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
}

.title-block[data-v-750c83a9] h1 {
  margin: 0;
  color: #0f172a;
  font-size: 24px;
  line-height: 1.15;
}

.top-metrics[data-v-750c83a9] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.top-metrics[data-v-750c83a9] span {
  display: grid;
  min-width: 58px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f3f6fb;
  color: #475569;
  font-size: 12px;
  line-height: 1.1;
}

.top-metrics[data-v-750c83a9] strong {
  color: #0f172a;
  font-size: 18px;
  line-height: 1;
}

.top-actions[data-v-750c83a9] {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.wizard-steps[data-v-750c83a9] {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 12px;
}

.wizard-steps[data-v-750c83a9] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  background: #fbfffd;
  color: #047857;
  font-weight: 800;
  cursor: pointer;
}

.wizard-steps[data-v-750c83a9] button.active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.wizard-steps[data-v-750c83a9] em {
  display: inline-grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 999px;
  background: #eaf2f7;
  color: #047857;
  font-style: normal;
  font-weight: 900;
}

.wizard-steps[data-v-750c83a9] button.active em {
  background: #2563eb;
  color: #fff;
}

.wizard-stage[data-v-750c83a9] {
  padding: 14px;
}

.wizard-stage[data-v-750c83a9] > span:first-child,
.worktable-head[data-v-750c83a9] > div:first-child > span,
.prompt-config-card[data-v-750c83a9] > span:first-child {
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
}

.wizard-stage[data-v-750c83a9] h2,
.worktable-head[data-v-750c83a9] h2 {
  margin: 2px 0 4px;
  color: #0f172a;
  font-size: 18px;
  line-height: 1.2;
}

.wizard-stage[data-v-750c83a9] p,
.worktable-head[data-v-750c83a9] p {
  margin: 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.step-one-grid[data-v-750c83a9] {
  display: grid;
  grid-template-columns: minmax(360px, 0.9fr) minmax(420px, 1.1fr);
  gap: 12px;
  margin-top: 12px;
}

.simple-product-card[data-v-750c83a9],
.simple-ai-card[data-v-750c83a9],
.confirm-column[data-v-750c83a9],
.confirm-summary-card[data-v-750c83a9],
.prompt-config-card[data-v-750c83a9] {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
}

.simple-product-card[data-v-750c83a9],
.simple-ai-card[data-v-750c83a9] {
  display: grid;
  gap: 10px;
}

.simple-product-card[data-v-750c83a9] h3,
.simple-ai-card[data-v-750c83a9] h3,
.confirm-column[data-v-750c83a9] h3,
.confirm-summary-card[data-v-750c83a9] h3 {
  margin: 0;
  color: #0f172a;
  font-size: 14px;
  line-height: 1.35;
}

.simple-product-facts[data-v-750c83a9],
.simple-fact-grid[data-v-750c83a9] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.simple-product-facts[data-v-750c83a9] span,
.simple-fact-grid[data-v-750c83a9] span {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid #edf2f7;
  border-radius: 8px;
  background: #f8fafc;
  color: #64748b;
  font-size: 12px;
}

.simple-product-facts[data-v-750c83a9] strong,
.simple-fact-grid[data-v-750c83a9] strong {
  color: #0f172a;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.simple-chip-block[data-v-750c83a9] {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.simple-warning[data-v-750c83a9] {
  padding: 8px 10px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
  color: #9a3412;
}

.stage-actions[data-v-750c83a9],
.secondary-actions[data-v-750c83a9],
.target-bulk-actions[data-v-750c83a9],
.prompt-plan-actions[data-v-750c83a9] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stage-actions[data-v-750c83a9] {
  margin-top: 12px;
}

.confirm-diy-grid[data-v-750c83a9] {
  display: grid;
}

.compact-field[data-v-750c83a9] {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
}

.compact-field[data-v-750c83a9] > span,
.prompt-plan-summary[data-v-750c83a9] > span {
  color: #334155;
  font-size: 12px;
  font-weight: 800;
}

.target-bulk-actions[data-v-750c83a9] {
  margin: 8px 0;
}

.target-select-summary[data-v-750c83a9] {
  color: #475569;
  font-size: 12px;
}

.compact-target-list[data-v-750c83a9] {
  display: grid;
  gap: 8px;
}

.compact-target-card[data-v-750c83a9] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #f8fbff;
  color: #0f172a;
  font-weight: 700;
}

.target-check[data-v-750c83a9] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.compact-empty-state[data-v-750c83a9] {
  display: grid;
  min-height: 120px;
  place-items: center;
  color: #94a3b8;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
}

.prompt-field-chips[data-v-750c83a9],
.mode-row[data-v-750c83a9] {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
  height: 34px;
  padding: 6px 10px;
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

.variant-text-cell[data-v-750c83a9] p:only-child {
  min-height: 24px;
}

.variant-text-cell[data-v-750c83a9] p:only-child,
.richtext-cell[data-v-750c83a9] p:only-child,
.variant-tags-cell[data-v-750c83a9] {
  display: grid;
  place-items: center;
  text-align: center;
}

.richtext-cell[data-v-750c83a9] p {
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

.variant-text-cell[data-v-750c83a9] p:only-child,
.richtext-cell[data-v-750c83a9] p:only-child {
  min-width: 96px;
  width: fit-content;
  max-width: 100%;
  margin-inline: auto;
  padding: 3px 10px;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  background: #eff6ff;
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
}

.table-tag-row[data-v-750c83a9] {
  max-height: 68px;
  overflow: auto;
}

.table-video-preview[data-v-750c83a9] {
  width: 78px;
  margin: 0 auto;
  justify-items: stretch;
  cursor: pointer;
}

.table-video-preview video[data-v-750c83a9],
.table-video-placeholder[data-v-750c83a9] {
  width: 78px;
  height: 104px;
  border-radius: 7px;
  object-fit: cover;
}

.table-video-preview strong[data-v-750c83a9] {
  display: block;
  max-width: 78px;
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

.import-source-dialog[data-v-750c83a9] .el-dialog {
  border-radius: 18px;
  overflow: hidden;
  background:
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.12), transparent 26%),
    linear-gradient(180deg, #f8fbff 0%, #f1f6fb 100%);
}

.import-source-dialog[data-v-750c83a9] .el-dialog__header {
  padding: 22px 24px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(248, 251, 255, 0.82));
}

.import-source-dialog[data-v-750c83a9] .el-dialog__title {
  color: #0f172a;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.01em;
}

.import-source-dialog[data-v-750c83a9] .el-dialog__body {
  padding: 18px 24px 12px;
}

.import-source-dialog[data-v-750c83a9] .el-dialog__footer {
  padding: 12px 24px 22px;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0), rgba(255, 255, 255, 0.92));
}

.import-dialog-body[data-v-750c83a9] {
  display: grid;
  gap: 16px;
}

.import-toolbar[data-v-750c83a9] {
  display: grid;
  grid-template-columns: 180px minmax(0, 1.15fr) minmax(0, 0.8fr) 280px auto auto;
  gap: 10px;
  align-items: center;
  padding: 14px;
  border: 1px solid rgba(191, 219, 254, 0.9);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.import-date-range[data-v-750c83a9] {
  width: 100%;
}

.import-list[data-v-750c83a9] {
  display: grid;
  gap: 12px;
  max-height: 55vh;
  padding: 6px 4px 6px 0;
  overflow: auto;
}

.import-row[data-v-750c83a9] {
  display: grid;
  grid-template-columns: 32px 88px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid #dbe5ef;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}

.import-row[data-v-750c83a9]:hover {
  transform: translateY(-1px);
  border-color: #93c5fd;
  box-shadow: 0 18px 34px rgba(37, 99, 235, 0.1);
}

.import-row.active[data-v-750c83a9] {
  border-color: #3b82f6;
  background: linear-gradient(135deg, rgba(239, 246, 255, 0.98), rgba(255, 255, 255, 0.98));
  box-shadow: 0 18px 36px rgba(59, 130, 246, 0.16);
}

.check-dot[data-v-750c83a9] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1.5px solid #bfdbfe;
  border-radius: 999px;
  background: #fff;
  color: #2563eb;
  font-size: 13px;
  font-weight: 800;
}

.import-row.active .check-dot[data-v-750c83a9] {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.import-thumb[data-v-750c83a9],
.import-row .visual[data-v-750c83a9] {
  width: 88px;
  height: 112px;
  border-radius: 14px;
}

.import-meta[data-v-750c83a9] {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.import-meta strong[data-v-750c83a9] {
  color: #0f172a;
  font-size: 15px;
  font-weight: 800;
  line-height: 1.35;
}

.import-meta em[data-v-750c83a9] {
  color: #475569;
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
}

.import-meta small[data-v-750c83a9] {
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.import-dialog-footer[data-v-750c83a9] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.import-footer-text[data-v-750c83a9] {
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.import-footer-actions[data-v-750c83a9] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

@media (max-width: 1280px) {
  .worktable-head[data-v-750c83a9] {
    display: grid;
  }

  .result-tools[data-v-750c83a9] {
    justify-content: flex-start;
  }

  .import-toolbar[data-v-750c83a9] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 860px) {
  .import-source-dialog[data-v-750c83a9] .el-dialog {
    width: min(96vw, 96vw) !important;
  }

  .import-source-dialog[data-v-750c83a9] .el-dialog__body,
  .import-source-dialog[data-v-750c83a9] .el-dialog__header,
  .import-source-dialog[data-v-750c83a9] .el-dialog__footer {
    padding-left: 16px;
    padding-right: 16px;
  }

  .import-toolbar[data-v-750c83a9] {
    grid-template-columns: 1fr;
  }

  .import-row[data-v-750c83a9] {
    grid-template-columns: 28px 72px minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
  }

  .import-thumb[data-v-750c83a9],
  .import-row .visual[data-v-750c83a9] {
    width: 72px;
    height: 92px;
  }

  .import-dialog-footer[data-v-750c83a9] {
    align-items: stretch;
  }

  .import-footer-actions[data-v-750c83a9] {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>


<style scoped>
.variant-image-cell[data-v-750c83a9] > span,
.variant-detail-cell[data-v-750c83a9] .table-detail-images > span,
.title-cell[data-v-750c83a9] > strong,
.desc-cell[data-v-750c83a9] > p,
.richtext-cell[data-v-750c83a9] > p,
.variant-video-cell[data-v-750c83a9] > span {
  display: grid;
  width: 100%;
  min-height: 82px;
  place-items: center;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: center;
}
.variant-tags-cell[data-v-750c83a9] .table-tag-row > span {
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
}
.variant-action-cell[data-v-750c83a9] {
  width: 210px;
  min-width: 210px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: center;
  align-items: center;
  padding-right: 10px;
}
.variant-action-head[data-v-750c83a9] {
  width: 210px;
  min-width: 210px;
}

.confirm-target-stage[data-v-750c83a9] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  max-height: calc(100vh - 210px);
  overflow: hidden;
}

.confirm-diy-grid[data-v-750c83a9] {
  grid-template-columns: minmax(420px, 0.95fr) minmax(420px, 1.05fr) 230px;
  gap: 12px;
  min-height: 0;
  align-items: stretch;
}

.confirm-column[data-v-750c83a9],
.confirm-summary-card[data-v-750c83a9] {
  min-height: 0;
}

.target-workbench-column[data-v-750c83a9],
.prompt-plan-column[data-v-750c83a9] {
  overflow: hidden;
}

.compact-target-list[data-v-750c83a9] {
  max-height: 232px;
  overflow: auto;
  align-content: start;
}

.compact-target-card[data-v-750c83a9] {
  min-height: 34px;
  padding: 6px 10px;
}

.compact-target-card[data-v-750c83a9] small {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prompt-plan-preview[data-v-750c83a9] {
  max-height: 190px;
  overflow: auto;
  padding: 8px 10px;
}

.prompt-plan-preview[data-v-750c83a9] > span {
  display: block;
  margin-bottom: 6px;
  color: #475569;
  font-size: 12px;
  font-weight: 800;
}

.prompt-plan-preview[data-v-750c83a9] article {
  display: grid;
  grid-template-columns: minmax(120px, 0.34fr) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #eef2f7;
}

.prompt-plan-preview[data-v-750c83a9] article:last-of-type {
  border-bottom: 0;
}

.prompt-plan-preview[data-v-750c83a9] article strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #0f172a;
}

.prompt-plan-preview[data-v-750c83a9] article p,
.prompt-plan-preview[data-v-750c83a9] .preview-compact-line {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
}

.confirm-summary-card[data-v-750c83a9] {
  align-self: start;
  position: sticky;
  top: 8px;
  padding: 12px;
}

.confirm-summary-card[data-v-750c83a9] .el-button {
  width: 100%;
}

.summary-count-list[data-v-750c83a9] {
  display: grid;
  gap: 4px;
  margin: 8px 0 10px;
}

.summary-count-list[data-v-750c83a9] p {
  margin: 0;
}

.stage-actions[data-v-750c83a9] {
  padding-top: 8px;
}

@media (max-width: 1280px) {
  .confirm-target-stage[data-v-750c83a9] {
    max-height: none;
    overflow: visible;
  }

  .confirm-diy-grid[data-v-750c83a9] {
    grid-template-columns: 1fr;
  }

  .confirm-summary-card[data-v-750c83a9] {
    position: static;
  }
}
</style>
