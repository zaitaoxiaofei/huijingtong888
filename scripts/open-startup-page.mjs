import { spawn } from "node:child_process";

const STARTUP_PAGE_PATH = "/admin.html#/login";

export function buildStartupPageUrl(appBaseUrl) {
  return new URL(STARTUP_PAGE_PATH, appBaseUrl).toString();
}

export function resolveOpenPageCommand(url, platform = process.platform) {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "\"\"", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function openStartupPage(appBaseUrl, options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    spawnFn = spawn
  } = options;

  if (env.OZON_OPEN_STARTUP_PAGE === "0") return "";

  const url = buildStartupPageUrl(appBaseUrl);
  const { command, args } = resolveOpenPageCommand(url, platform);
  let child;
  try {
    child = spawnFn(command, args, { detached: true, stdio: "ignore" });
  } catch {
    return "";
  }
  child.on?.("error", () => {});
  child.unref?.();
  return url;
}
