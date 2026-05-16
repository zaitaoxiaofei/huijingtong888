import { onBeforeUnmount, onMounted } from "vue";

function closePreview() {
  const closeButton = document.querySelector(".el-image-viewer__close");
  if (closeButton instanceof HTMLElement) {
    closeButton.click();
  }
}

function handlePreviewClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.classList.contains("el-image-viewer__mask")) {
    closePreview();
    return;
  }

  if (
    target.classList.contains("el-image-viewer__wrapper") &&
    !target.closest(".el-image-viewer__canvas") &&
    !target.closest(".el-image-viewer__btn")
  ) {
    closePreview();
  }
}

export function useGlobalImagePreviewDismiss() {
  onMounted(() => {
    document.addEventListener("click", handlePreviewClick, true);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("click", handlePreviewClick, true);
  });
}
