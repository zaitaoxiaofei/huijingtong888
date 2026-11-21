import OSS from "ali-oss";

export function ossInternalEnabled(env = process.env) {
  return ["true", "1"].includes(String(env.OSS_INTERNAL_READ || "").trim().toLowerCase());
}

// Server traffic follows the configured network. Returned browser/Ozon URLs
// remain public; network errors never silently select a different endpoint.
export function createServerOssClient(storage, {
  env = process.env,
  timeoutMs = 60000,
  internal = ossInternalEnabled(env)
} = {}) {
  return new OSS({
    region: storage.region,
    bucket: storage.bucket,
    accessKeyId: storage.accessKeyId,
    accessKeySecret: storage.accessKeySecret,
    stsToken: storage.stsToken || undefined,
    secure: true,
    internal,
    timeout: Math.max(1000, Number(timeoutMs) || 60000)
  });
}
