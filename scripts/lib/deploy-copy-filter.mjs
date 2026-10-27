import path from "node:path";
import fs from "node:fs/promises";

const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Release sources are stable during copying. Inspect directory entries once,
// then resolve only links; ordinary files need no additional per-file lstat.
export function createDeployCopyFilter(rootDir, { includeUploads = false, privateResultRoot = "" } = {}) {
  const root = path.resolve(rootDir);
  const privateRoots = [path.join(root, "data", "ai-credit-results"), path.join(root, "data", "ai-media-retention")];
  if (privateResultRoot) privateRoots.push(path.resolve(root, privateResultRoot));
  const uploads = path.join(root, "public", "uploads");
  const excludedRoots = includeUploads ? privateRoots : [...privateRoots, uploads];
  const directories = new Map();
  let realExcludedRoots;
  const resolvedRoots = () => realExcludedRoots ||= Promise.all(excludedRoots.map(async excluded => {
    try { return await fs.realpath(excluded); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return excluded; throw error; }
  }));
  return async sourcePath => {
    const source = path.resolve(sourcePath);
    if (excludedRoots.some(excluded => within(excluded, source))) return false;
    const parent = path.dirname(source);
    if (!directories.has(parent)) directories.set(parent, fs.readdir(parent, { withFileTypes: true })
      .then(entries => new Map(entries.map(entry => [entry.name, entry]))));
    // A newly added entry is not implicitly a normal file. Resolve only that
    // cache miss; a disappearing/replaced source makes packaging fail closed.
    const entry = (await directories.get(parent)).get(path.basename(source)) || await fs.lstat(source);
    if (!entry.isSymbolicLink()) return true;
    const target = path.resolve(parent, await fs.readlink(source));
    if (excludedRoots.some(excluded => within(excluded, target) || within(target, excluded))) return false;
    let realTarget;
    try { realTarget = await fs.realpath(source); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    // A link to an ancestor also exposes the private subtree through its alias.
    return !(await resolvedRoots()).some(excluded => within(excluded, realTarget) || within(realTarget, excluded));
  };
}
