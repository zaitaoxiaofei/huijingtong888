import path from "node:path";

const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Test the source pathname before fs.cp copies or preserves a symlink. Private
// runtime results never belong to a release, even when public uploads are opted in.
export function createDeployCopyFilter(rootDir, { includeUploads = false, privateResultRoot = "" } = {}) {
  const root = path.resolve(rootDir);
  const privateRoots = [path.join(root, "data", "ai-credit-results")];
  if (privateResultRoot) privateRoots.push(path.resolve(root, privateResultRoot));
  const uploads = path.join(root, "public", "uploads");
  return sourcePath => {
    const source = path.resolve(sourcePath);
    return !privateRoots.some(privateRoot => within(privateRoot, source)) && (includeUploads || !within(uploads, source));
  };
}
