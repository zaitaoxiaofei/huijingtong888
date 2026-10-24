import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const digest = data => createHash("sha256").update(data).digest("hex");
const fail = () => Object.assign(new Error("AI 结果引用或完整性校验失败"), { status: 409, code: "AI_CREDIT_RESULT_INVALID" });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export function createAiCreditResultStore(root, { publicRoots = [path.resolve("public"), path.resolve("uploads")] } = {}) {
  if (!path.isAbsolute(root)) throw new Error("Private AI result store requires an absolute directory outside public uploads");
  const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
  if (publicRoots.some(parent => inside(path.resolve(parent), path.resolve(root)))) throw new Error("AI result store cannot be inside a public directory");
  let verifiedRoot;
  async function privateRoot() {
    if (!verifiedRoot) verifiedRoot = (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const real = await fs.realpath(root);
      for (const parent of publicRoots) {
        const publicReal = await fs.realpath(parent).catch(error => { if (error.code === "ENOENT") return path.resolve(parent); throw error; });
        if (inside(publicReal, real)) throw new Error("AI result store resolves into a public directory");
      }
      return real;
    })().catch(error => { verifiedRoot = null; throw error; });
    return verifiedRoot;
  }
  function location(task) {
    if (!uuid(task.id) || !Number.isSafeInteger(Number(task.tenant_id)) || Number(task.tenant_id) < 1) throw fail();
    return path.join(root, String(task.tenant_id), `${task.id}.json`);
  }
  function unpack(bytes, task) {
    if (bytes.length > 2 * 1024 * 1024) throw fail();
    let saved;
    try { saved = JSON.parse(bytes.toString("utf8")); } catch { throw fail(); }
    if (saved?.format !== "ai-credit-result-v1" || saved.task_id !== task.id || Number(saved.tenant_id) !== Number(task.tenant_id)
      || saved.input_sha256 !== task.input_sha256 || !Object.hasOwn(saved, "result")) throw fail();
    return saved.result;
  }
  return {
    async write(task, result) {
      await privateRoot();
      const data = Buffer.from(JSON.stringify({ format: "ai-credit-result-v1", task_id: task.id, tenant_id: Number(task.tenant_id),
        input_sha256: task.input_sha256, result })), sha256 = digest(data), file = location(task);
      if (data.length > 2 * 1024 * 1024) throw fail();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = await fs.open(temporary, "wx", 0o600);
        try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
        // Hard-link atomically installs an immutable result without overwriting
        // an existing task. Replays must reproduce its exact bytes.
        try { await fs.link(temporary, file); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (digest(await fs.readFile(file)) !== sha256) throw fail();
        }
        try {
          const directory = await fs.open(path.dirname(file), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        } catch (error) {
          // Windows does not expose directory fsync through Node. Linux must
          // persist the newly installed directory entry before settling money.
          if (process.platform !== "win32" || !["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
        }
      } finally { await fs.rm(temporary, { force: true }); }
      return { reference: `credit-result:${task.id}`, sha256 };
    },
    async read(reference, sha256, task) {
      await privateRoot();
      if (reference !== `credit-result:${task.id}` || !/^[a-f0-9]{64}$/.test(String(sha256))) throw fail();
      const bytes = await fs.readFile(location(task));
      if (bytes.length > 2 * 1024 * 1024 || digest(bytes) !== sha256) throw fail();
      return unpack(bytes, task);
    },
    async recover(task) {
      await privateRoot();
      let bytes;
      try { bytes = await fs.readFile(location(task)); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      // A private candidate is not yet a bill. Its task/input envelope must
      // match, and the provider adapter must verify the actual delivered media
      // before the executor can settle it without another supplier request.
      return { reference: `credit-result:${task.id}`, sha256: digest(bytes), result: unpack(bytes, task) };
    }
  };
}
