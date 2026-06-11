<script>
import { defineAsyncComponent, h } from "vue";

const AiOptimizationWorkbenchRuntime = defineAsyncComponent(() =>
  import(/* @vite-ignore */ "/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-20260611213517.js")
);

export default {
  name: "AiOptimizationWorkbenchV2",
  setup() {
    return () => h(AiOptimizationWorkbenchRuntime);
  }
};
</script>
