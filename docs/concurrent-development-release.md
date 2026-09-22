# 并行开发与 ECS 发布

每个任务使用独立 worktree：`node scripts/create-task-worktree.mjs <task-name>`。

任务只提交自己的分支；集成者合并到 `main` 或 `release/*` 后，再从干净工作区执行 `bash deploy/linux/deploy-ecs.sh`。发布脚本默认拒绝脏工作区，防止其他线程的半成品进入整包。
