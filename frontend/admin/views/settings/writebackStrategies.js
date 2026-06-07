export function createWritebackStrategies(deps = {}) {
  const {
    task,
    router,
    apiClient,
    selectionTemplateReady,
    createDerivedSelectionRecord,
    safeOverwriteSelectionSource,
    forceOverwriteSelectionSource,
    overwriteSelectionSource,
    overwriteCollectorSource,
    overwriteListingRecordSource,
    bundleMaySyncRichContent
  } = deps;

  const createListingWorkbenchId = () => `liwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    new_selection: {
      key: "new_selection",
      ready: Boolean(selectionTemplateReady),
      actionLabel: "生成新的选品记录",
      confirmLabel: "生成",
      batchLabel: "将生成 {count} 条新选品记录。",
      submit: async (bundle) => {
        const created = await createDerivedSelectionRecord(bundle);
        return { ...created, message: `已创建新选品记录 ${created?.product?.selection_id || created?.selection_id || created?.id || ""}` };
      }
    },
    safe_overwrite_selection: {
      key: "safe_overwrite_selection",
      ready: Boolean(task?.sourceSelectionId),
      actionLabel: "安全回写当前选品池",
      confirmLabel: "回写",
      batchLabel: "将安全回写当前选品池商品，只更新 AI 承接字段与素材补充位。",
      submit: async (bundle) => {
        const product = await (safeOverwriteSelectionSource || overwriteSelectionSource)(bundle);
        return { ...product, selectionId: product?.id || task?.sourceSelectionId, message: "已安全回写当前选品池商品" };
      }
    },
    force_overwrite_selection: {
      key: "force_overwrite_selection",
      ready: Boolean(task?.sourceSelectionId),
      actionLabel: "强制覆盖当前选品池",
      confirmLabel: "强制覆盖",
      batchLabel: "将强制覆盖当前选品池商品，AI 标题、标签、描述会直接写入母数据字段。",
      requiresConfirm: true,
      confirmTitle: "强制覆盖选品池",
      confirmDetail: (bundle) => (
        bundleMaySyncRichContent(bundle)
          ? "将强制覆盖当前选品池商品的标题、标签、描述等母数据字段，并同步更新富文本。后续自动主题标签流程可能继续覆盖这些字段，请确认。"
          : "将强制覆盖当前选品池商品的标题、标签、描述等母数据字段。后续自动主题标签流程可能继续覆盖这些字段，请确认。"
      ),
      submit: async (bundle) => {
        const product = await forceOverwriteSelectionSource(bundle);
        return { ...product, selectionId: product?.id || task?.sourceSelectionId, message: "已强制覆盖当前选品池商品" };
      }
    },
    overwrite_selection: {
      key: "overwrite_selection",
      ready: Boolean(task?.sourceSelectionId),
      actionLabel: "安全回写当前选品池",
      confirmLabel: "回写",
      batchLabel: "将安全回写当前选品池商品，只更新 AI 承接字段与素材补充位。",
      submit: async (bundle) => {
        const product = await (safeOverwriteSelectionSource || overwriteSelectionSource)(bundle);
        return { ...product, selectionId: product?.id || task?.sourceSelectionId, message: "已安全回写当前选品池商品" };
      }
    },
    overwrite_collector: {
      key: "overwrite_collector",
      ready: Boolean(task?.sourceCollectorSku),
      actionLabel: "更新当前采集箱内容",
      confirmLabel: "更新",
      batchLabel: "将更新当前采集箱内容。",
      submit: async (bundle) => {
        const result = await overwriteCollectorSource(bundle);
        return { ...result, message: "已覆盖当前采集箱补充信息" };
      }
    },
    overwrite_listing_record: {
      key: "overwrite_listing_record",
      ready: Boolean(task?.sourceListingRecordId),
      actionLabel: "更新当前上架记录",
      confirmLabel: "更新",
      batchLabel: "将更新当前上架记录。",
      requiresConfirm: true,
      confirmTitle: "更新上架记录",
      confirmDetail: (bundle) => (
        bundleMaySyncRichContent(bundle)
          ? "将更新当前上架记录并重新提交。如首图、详情图或描述发生变化，将同步更新富文本。"
          : "将更新当前上架记录并重新提交。"
      ),
      submit: async (bundle) => {
        const result = await overwriteListingRecordSource(bundle);
        return { ...result, message: "已更新上架记录并重新提交" };
      }
    },
    online_product_to_template: {
      key: "online_product_to_template",
      ready: Boolean(task?.sourceId),
      actionLabel: "生成在线商品上架模板",
      confirmLabel: "生成模板",
      batchLabel: "将把当前在线商品 AI 结果生成到上架模板。",
      submit: async (bundle) => {
        const result = await apiClient.post("/api/listing/templates/from-online-product", {
          online_product_id: Number(task?.sourceId || 0),
          template_name: task?.title || task?.productName || `在线商品编辑 / ${task?.sourceId || ""}`,
          ai_bundle: {
            mainImageUrl: bundle?.mainImageUrl || "",
            detailImageUrls: bundle?.detailImageUrls || [],
            generatedTitles: bundle?.generatedTitles || [],
            generatedTags: bundle?.generatedTags || [],
            generatedDescription: bundle?.generatedDescription || ""
          }
        });
        const templateId = result?.template?.id;
        if (templateId) {
          router.push({
            path: "/listing-automation",
            query: {
              workbenchId: createListingWorkbenchId(),
              templateId,
              onlineProductId: String(task?.sourceId || "")
            }
          });
        }
        const summary = result?.diagnostics?.summary || result?.template?.mapping_diagnostics?.summary || {};
        const riskText = Number(summary.blockers || 0) || Number(summary.warnings || 0)
          ? `，诊断 ${Number(summary.blockers || 0)} 个阻断 / ${Number(summary.warnings || 0)} 个提醒`
          : "";
        return { ...result, message: `${result?.reused ? "已打开在线商品上架模板" : "已生成在线商品上架模板"}${riskText}` };
      }
    },
    asset_only: {
      key: "asset_only",
      ready: false,
      actionLabel: "当前来源暂不支持直接提交",
      confirmLabel: "保存",
      batchLabel: "当前来源暂不支持提交",
      submit: async () => {
        throw new Error("当前来源暂不支持提交");
      }
    }
  };
}
