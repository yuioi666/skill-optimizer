# 任务格式

每个任务位于 `inputs/<任务名>/`：

```text
original-skill/SKILL.md
job.json
development.jsonl
regression.jsonl
holdout.jsonl
```

从 `examples/meeting-summary` 复制结构，再替换内容。`job.json` 保存目标、评分维度、通过门槛、迭代次数和超时。三个 JSONL 文件每行一个案例，ID 和输入不得跨集合重复。

开发集覆盖已知能力缺口，优化角色可以看到。回归集覆盖原本正确的能力，只用于判断是否退步。保留集覆盖独立场景，候选冻结后才运行，结果不得反馈给本轮优化。
