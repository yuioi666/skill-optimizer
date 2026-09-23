---
name: skill-optimizer-workbench
description: 在 Codex 桌面工作区中，根据用户需求创建测试集，协调可见子 Agent，并用可配置模型评估和优化 Agent Skill。用于用户提出优化、测试、验收或比较 Skill 的任务。
---

# Skill 优化工作台

以桌面端对话为入口。用户描述需求后，主动定位目标 Skill 和测试材料；不要要求用户记忆终端命令。

## 工作方式

1. 说明准备创建的子 Agent 及其职责。
2. 并行委派 `requirements_analyst` 和 `test_designer`，让它们返回独立结论。用户可在桌面端打开各线程查看。
3. 主 Agent 合并结论，在 `inputs/<任务名>/` 创建或更新任务配置。保留用户明确要求，不将单个案例答案写入 Skill。
4. 读取 `config/models.local.json`。缺失时复制 `config/models.example.json`，并只在确实需要第三方凭据时请用户填写。API Key 不得出现在对话、提示、日志或 Git 中。
5. 在产生模型调用前确认用户要运行的对比线路和采样强度。若用户尚未指定，必须询问一次，并说明按当前案例数估算的基础调用量与重试上限：`skill-vs-none`（无 Skill 与原版，只验证有效性）、`original-vs-candidate`（原版与候选，只优化并防退步）或 `all`（三者全部比较）；`samplesPerCase: 1` 为省调用，`3` 为更稳健的中位数评估。把选择写入 `job.json`。默认只优化一轮；增加轮数或产生额外付费调用前说明预计调用量。
6. 委派 `evaluation_operator` 运行配置校验和所选线路。`skill-vs-none` 不得调用优化器或生成候选版本。
7. 委派 `result_auditor` 独立复核运行证据。只有包含候选的线路且开发集、回归集和保留集均通过时，才交付 `final/` 中的候选版本。
8. 在主对话中提供各 Agent 的状态、关键发现，以及报告和候选 Skill 的可点击路径。

## 模型边界

`.codex/agents/` 中的线程是 Codex 原生子 Agent，可在桌面端查看。`config/models.local.json` 中配置的第三方模型是评估引擎调用的 worker；它们的调用状态和产物由 `evaluation_operator` 展示，不能声称为原生子 Agent。

需要创建任务文件时读取 [任务格式](references/task-format.md)。需要配置第三方模型时读取 [模型配置](references/model-config.md)。

## 质量约束

- 原始 Skill 永不覆盖。
- 无 Skill 对比只能使用公共任务需求、公共 rubric 和输入可推导的硬检查；Skill 特有约定必须写入 `skillRequirements`、`skillRubric` 或 `skillChecks`，单独报告。
- 优化角色只能看到需求、开发集和开发反馈。
- 回归集用于拒绝退步，不作为优化提示。
- 候选冻结后才运行保留集；失败即停止本轮。
- 模型分数必须与确定性检查、实际产物和人工可读证据一起报告。
- 涉及脚本、工具或文件产物的 Skill，必须在隔离副本中运行实际任务；仅注入 `SKILL.md` 的文本测试不能宣称覆盖完整行为。
