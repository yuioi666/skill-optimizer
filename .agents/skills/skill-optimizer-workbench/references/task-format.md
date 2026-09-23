# 任务格式

每个任务位于 `inputs/<任务名>/`：

```text
original-skill/SKILL.md
job.json
development.jsonl
regression.jsonl
holdout.jsonl
```

从 `examples/meeting-summary` 复制结构，再替换内容。`job.json` 保存目标、评分维度、通过门槛、迭代次数、超时和 `comparisonMode`。三个可选线路为：`skill-vs-none`（无 Skill 与原版）、`original-vs-candidate`（原版与候选）和 `all`（三者全部）。运行模型前必须让用户选择线路。旧任务中的 `compareWithoutSkill: true` 会兼容映射为 `all`，新任务不要再使用该字段。三个 JSONL 文件每行一个案例，ID 和输入不得跨集合重复。

为了让无 Skill 对比公平，任务标准与 Skill 特有约定必须分开：

- `requirements` 和 `rubric`：不依赖 Skill 也成立的公共任务目标，用于所有线路。
- `skillRequirements` 和 `skillRubric`：只有获得 Skill 后才应遵守的格式、术语和流程约定，不用于计算无 Skill uplift。
- 案例的 `checks`：输入可推导的公共硬检查。
- 案例的 `skillChecks`：Skill 特有约定，只检查原版和候选。

`checks` 与 `skillChecks` 支持：`includes`（全部包含）、`containsAny`（至少包含一个）、`excludes`、`matches`、`notMatches`、`minChars`、`maxChars`，以及按 RFC 6901 路径检查 JSON 值的 `jsonEquals`。正则表达式使用 JavaScript Unicode 模式。结构化 JSON 示例：

```json
{"jsonEquals":[{"path":"/status","value":"ok"},{"path":"/owner/name","value":"小林"}]}
```

候选软分按整个数据集聚合，再用 `scoreTolerance` 容忍轻微评分波动；确定性检查仍可否决候选。`minComparisonCases` 控制方向性结论的最低案例数，未达到时报告“样本不足”，不会宣称 Skill 已被证明有效。

`samplesPerCase` 控制每个案例独立运行次数，范围 1–5，使用中位数聚合；1 次节省调用，正式评估建议 3 次。`maxAttemptsPerCall` 控制单次 runner、evaluator 或 optimizer 调用失败后的最大尝试次数，范围 1–3。失败记录保留在对应角色目录；重试耗尽会标记证据缺失并阻止候选通过，不会把缺失当成 0 分。

开发集覆盖已知能力缺口，优化角色可以看到。回归集覆盖原本正确的能力，只用于判断是否退步。保留集覆盖独立场景，候选冻结后才运行，结果不得反馈给本轮优化。

## 单轮最大模型调用量

设开发、回归、保留案例数分别为 `D`、`R`、`H`，每案例采样次数为 `S`。每个样本包含一次 runner 和一次 evaluator 调用，单轮优化器另计一次：

- `skill-vs-none`：`4 × S × (D + R + H)`
- `original-vs-candidate`：`4 × S × (D + R + H) + 1`
- `all`：`6 × S × (D + R + H) + 1`

这是没有重试且候选通过并运行保留集时的基础调用量。设 `maxAttemptsPerCall` 为 `A`，异常情况下的理论上限为基础调用量乘以 `A`。候选提前被拒绝时不会产生后续保留集调用；每增加一轮候选优化，基础调用量最多再增加 `1 + 2 × S × (D + R)` 次。
