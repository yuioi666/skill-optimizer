# Skill 优化工作台

这是一个以 Codex 桌面客户端为主要入口的 Agent Skill 测试与优化工作区。用户通过对话描述需求，Codex 负责创建测试、协调子 Agent、调用配置的模型、运行评估并交付候选 Skill。

## 桌面端使用流程

1. 在 Codex 桌面客户端打开本项目文件夹。
2. 将待优化 Skill 和测试材料放入 `inputs/`，也可以直接在对话中告诉 Codex 文件位置。
3. 对 Codex 说：

   > 根据我的需求测试并优化这个 Skill。它应该……，不能……。请创建多个 Agent，并让我看到每个 Agent 的工作过程。

4. Codex 会在桌面端创建并展示以下子 Agent：

   - `requirements_analyst`：整理需求和验收标准。
   - `test_designer`：设计开发集、回归集和保留集。
   - `evaluation_operator`：运行原版、候选版和模型评审。
   - `result_auditor`：独立检查回归、数据泄漏和最终结论。

5. 主对话会汇总进度，并提供运行状态、报告和候选 Skill 的可点击路径。

仓库根目录的 `AGENTS.md` 和 `.agents/skills/skill-optimizer-workbench/` 会让 Codex 自动识别这套流程。`.codex/agents/` 定义桌面端可见的项目子 Agent。

## 放入自己的 Skill

`examples/` 只保存演示，`inputs/` 保存用户任务。用户可以只把材料放进工作区并让 Codex 整理，也可以从示例复制：

```powershell
Copy-Item examples/meeting-summary inputs/my-skill -Recurse
```

任务结构：

```text
inputs/my-skill/
├─ original-skill/
│  └─ SKILL.md
├─ job.json
├─ development.jsonl
├─ regression.jsonl
└─ holdout.jsonl
```

`inputs/` 下的用户材料默认不提交 Git。当前执行引擎主要验证 `SKILL.md` 的文本行为；需要脚本、工具和文件产物的 Skill，必须由 Codex 为其增加隔离项目测试，不能仅凭文本评测宣布通过。

## 配置每个角色的模型

用户只需编辑：

```text
config/models.local.json
```

这个文件已被 `.gitignore` 排除，不会上传 GitHub。仓库提供 `config/models.example.json` 作为模板。

配置由两部分组成：

- `providers`：API 地址、API Key 和提供商类型。
- `roles`：为执行、优化和评审分别选择 provider 与 model。

例如，执行使用本地 Ollama，优化使用 Anthropic，评审使用 Codex：

```json
{
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "",
      "structuredOutput": "prompt"
    },
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "在本机填写",
      "apiVersion": "2023-06-01"
    },
    "codex": {
      "type": "codex",
      "model": ""
    }
  },
  "roles": {
    "runner": { "provider": "ollama", "model": "qwen3:8b" },
    "optimizer": { "provider": "anthropic", "model": "填写账号可用的模型名" },
    "evaluator": { "provider": "codex", "model": "" }
  }
}
```

支持的 provider 类型：

| 类型 | 说明 |
|---|---|
| `codex` | 使用本机已登录的 Codex CLI |
| `openai-compatible` | 使用 `/v1/chat/completions`，适用于 Ollama、LM Studio 和兼容服务 |
| `anthropic` | 使用 Anthropic Messages API |
| `command` | 调用从标准输入读取提示的本机命令行模型 |

`.codex/agents/*.toml` 中的 Agent 是 Codex 原生子 Agent，能在桌面端打开线程。第三方模型是 `evaluation_operator` 管理的外部 worker，其阶段和产物会显示在桌面对话与 `runs/<运行编号>/status.md` 中。

## 测试与结果

Codex 会代用户运行底层程序。需要排查时仍可使用：

```powershell
npm test
node scripts/cli.mjs validate --job inputs/my-skill
npm run doctor
npm run smoke
npm run optimize -- --job inputs/my-skill --iterations 1
```

- `smoke` 会使用 `runner` 的配置实际调用一次模型。
- `runs/<运行编号>/status.md` 是当前阶段面板。
- `runs/<运行编号>/report.md` 是完整评估报告。
- `final/<运行编号>/candidate-skill/SKILL.md` 是通过验收的候选版本。
- 原始 Skill 永不覆盖。

开始模型调用前，Codex 会请用户选择对比线路：

| 线路 | `comparisonMode` | 用途 |
|---|---|---|
| 无 Skill vs 原版 | `skill-vs-none` | 只验证 Skill 是否带来提升，不调用优化器 |
| 原版 vs 候选 | `original-vs-candidate` | 优化 Skill 并检查是否退步 |
| 三者全部 | `all` | 同时验证有效性与优化效果，调用量最高 |

所选线路写入 `job.json`。报告使用相同 runner 和相同案例进行公平比较。包含候选的线路按“原版开发集与回归集 → 候选优化 → 候选开发集与回归集 → 冻结候选 → 保留集验收”执行。优化角色看不到回归集和保留集内容；保留集失败后本轮停止。

以 5 个开发案例、4 个回归案例和 4 个保留案例为例，单轮全部通过时三个线路的最大调用量依次约为 52、53 和 79 次。候选提前被拒绝时不会继续消耗保留集调用。

旧任务中的 `compareWithoutSkill: true` 仍兼容，会按 `all` 运行；新任务应使用 `comparisonMode`。

## 设计参考

项目调研并借鉴了以下开源项目的公开设计思想，没有复制其代码：

- [Agent Skill Evals](https://github.com/akshay5995/agent-skill-evals)：Skill 测试包、隔离运行、运行证据和路由测试。
- [Promptfoo](https://github.com/promptfoo/promptfoo)：多提供商评测矩阵、断言和报告查看。
- [LiteLLM](https://github.com/BerriAI/litellm)：多模型提供商的统一路由思路。
- [Opik](https://github.com/comet-ml/opik) 与 [Langfuse](https://github.com/langfuse/langfuse)：Agent trace、数据集、实验和可观测性。
- [DSPy](https://github.com/stanfordnlp/dspy)：以评测指标驱动提示优化。

当前版本保持本地、轻量、无数据库，不要求用户另开评测平台。后续如果需要完整的项目夹具、工具调用断言和 Web 评测矩阵，优先考虑接入 Agent Skill Evals 与 Promptfoo，而不是重复实现。

Codex 桌面端子 Agent 和项目 Agent 配置依据 [OpenAI 官方子 Agent 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)，仓库 Skill 依据 [OpenAI 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)。
