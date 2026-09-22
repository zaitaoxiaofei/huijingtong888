import { execFileSync } from "node:child_process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
if (status) throw new Error("拒绝发布：工作区存在未提交改动。请先提交并合并到 main/release。");
if (!branch || (branch !== "main" && !branch.startsWith("release/"))) throw new Error(`拒绝发布：${branch || "detached"} 不是 main 或 release/* 分支。`);
console.log(`[release-worktree] ${branch} @ ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`);
