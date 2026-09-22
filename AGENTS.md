# Skill 优化工作区

当用户要求创建、测试、评估或优化 Agent Skill 时，使用仓库内的 `$skill-optimizer-workbench` 技能完成工作。以 Codex 桌面端对话为主要入口，不要求用户手动执行命令。

对于完整优化任务，创建可在桌面端查看的子 Agent：需求分析、测试设计、评估执行和结果审计。向用户说明各 Agent 的职责并报告阶段进度。第三方模型通过 `config/models.local.json` 调用；不要把它们描述成 Codex 原生子 Agent。

保护原始 Skill。候选版本写入运行目录，通过验收后再复制到 `final/`。保留集不得交给优化角色，也不得在保留集失败后继续针对同一保留集优化。

运行 JavaScript 测试后再提交代码。不得提交 `config/models.local.json`、`inputs/` 中的用户材料、`runs/`、`final/` 或任何 API Key。
