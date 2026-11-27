// A display may stop reading without stopping the server task it is showing.
export function createDisplayReadScope({ visible = true, onResume = () => {}, onPause = () => {} } = {}) {
  let active = false, blocked = false, disposed = false;
  const controllers = new Set();
  const canRead = () => active && visible && !blocked && !disposed;
  function cancel() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  function change(update) {
    const wasReading = canRead();
    update();
    if (wasReading && !canRead()) {
      cancel();
      onPause();
    } else if (!wasReading && canRead()) onResume();
  }
  return {
    canRead,
    cancel,
    activate: () => change(() => { active = true; }),
    deactivate: () => change(() => { active = false; }),
    setVisible: value => change(() => { visible = Boolean(value); }),
    resetAuthorization: () => change(() => { blocked = false; }),
    reject(error) {
      if (![401, 403].includes(Number(error?.status || error?.statusCode))) return false;
      change(() => { blocked = true; });
      return true;
    },
    controller() {
      if (!canRead()) return null;
      const controller = new AbortController();
      controllers.add(controller);
      return controller;
    },
    release: controller => controllers.delete(controller),
    dispose: () => change(() => { disposed = true; })
  };
}
