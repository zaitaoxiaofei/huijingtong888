import { execFileSync } from "node:child_process";
import path from "node:path";

const [taskName] = process.argv.slice(2);
if (!taskName || !/^[a-z0-9][a-z0-9-]*$/.test(taskName)) throw new Error("Usage: node scripts/create-task-worktree.mjs <task-name>");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("共享工作区有未提交改动；请从干净的 main/release worktree 创建任务。");
const branch = `codex/${taskName}`;
const destination = path.resolve(root, "..", "ozon-system-worktrees", taskName);
try {
  execFileSync("git", ["worktree", "add", destination, branch], { cwd: root, stdio: "inherit" });
} catch {
  execFileSync("git", ["worktree", "add", "-b", branch, destination, "main"], { cwd: root, stdio: "inherit" });
}
console.log(`任务工作区：${destination}\n分支：${branch}`);
