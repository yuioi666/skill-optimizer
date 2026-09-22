# 本地 Skill 评估与优化

项目就在当前目录。无需安装 npm 依赖、数据库或 Docker。需要 Node.js 22+；使用 `codex` adapter 时还需要已登录的 Codex CLI，其他 adapter 使用各自的模型服务或命令。

## 开始使用

在此目录打开终端：

```powershell
npm run doctor
npm test
npm run validate
npm run demo
```

双击 `演示.cmd` 也可以运行模拟示例。模拟模式不调用模型，评分是预设的，只用于验证程序流程。

真实执行：

```powershell
npm run smoke
npm run optimize -- --job inputs/my-skill --iterations 1
```

也可将任务目录拖到 `真实优化.cmd` 上运行。真实优化必须明确指定 `inputs/` 下的任务，不会默认运行会议摘要示例。真实运行使用本机 Codex 登录和默认模型，会消耗账号额度。`--model 模型名` 可以显式指定本机可用模型。默认示例一轮最多需要 17 次模型调用（第二轮另加 7 次），每次默认最多 3 分钟。若原版已达到门槛，候选版允许持平，报告不会把持平称作提升。

## 换成自己的 Skill

`examples/` 只保存演示，`inputs/` 保存你自己的评估任务。先复制示例结构：

```powershell
Copy-Item examples/meeting-summary inputs/my-skill -Recurse
```

然后：

1. 将你的 Skill 正文放进 `inputs/my-skill/original-skill/SKILL.md`。
2. 修改 `job.json` 中需求、评分标准、门槛和最多迭代次数。
3. 修改三个 JSONL 案例文件，每行一个 JSON 对象，分别用于开发、回归和保留测试。输入及 ID 不允许重复。
4. 执行下面的命令。

```powershell
node scripts/cli.mjs validate --job inputs/my-skill
npm run optimize -- --job inputs/my-skill --iterations 1
```

`inputs/` 下的个人任务默认不提交到 Git，避免把私有 Skill 或测试材料意外上传。需要纳入版本管理时，可以调整 `.gitignore`。

检查支持 `includes` 必须包含、`excludes` 禁止包含、`maxChars` 字数上限。文本匹配是字面检查，要避免禁止词同时出现在合理的否定句中。模型评分按 `rubric` 各维度等权计算，0–4 分归一化；每个案例必须达到门槛、通过确定性检查且不低于原版同一案例。

## 使用其他模型

项目支持四种 adapter：

| adapter | 用途 |
|---|---|
| `mock` | 不调用模型，只验证流程 |
| `codex` | 使用已登录的 Codex CLI |
| `openai-compatible` | 使用提供 `/v1/chat/completions` 的本地或云端模型服务 |
| `command` | 使用能从标准输入接收提示、向标准输出返回答案的任意命令行模型 |

### OpenAI 兼容接口

设置接口地址和模型名后运行：

```powershell
$env:MODEL_BASE_URL = "http://localhost:1234/v1"
$env:MODEL_NAME = "你的模型标识"
$env:MODEL_API_KEY = "需要鉴权时填写"
npm run smoke -- --adapter openai-compatible
npm run optimize:api -- --job inputs/my-skill --iterations 1
```

可以先运行 `node scripts/cli.mjs doctor --adapter openai-compatible` 检查配置；`smoke` 会实际调用一次模型。

常见本地服务地址：

- [LM Studio](https://lmstudio.ai/docs/developer/openai-compat)：`http://localhost:1234/v1`
- [Ollama](https://docs.ollama.com/api/openai-compatibility)：`http://localhost:11434/v1`

其他兼容服务使用其提供的 base URL。默认通过提示要求结构化 JSON，兼容范围更广。如果服务明确支持 JSON Schema，可以设置：

```powershell
$env:MODEL_STRUCTURED_OUTPUT = "json_schema"
```

密钥只通过请求头发送，不写入运行记录。不要把密钥写进 `job.json` 或命令参数。

### 通用命令行模型

`MODEL_COMMAND` 填可执行文件，`MODEL_ARGS_JSON` 填参数数组。参数中的 `{model}` 会替换为 `--model` 或 `MODEL_NAME` 的值。

```powershell
$env:MODEL_COMMAND = "你的模型命令"
$env:MODEL_ARGS_JSON = '["参数1", "{model}"]'
$env:MODEL_NAME = "模型名"
npm run smoke -- --adapter command
npm run optimize:command -- --job inputs/my-skill --iterations 1
```

可以先运行 `node scripts/cli.mjs doctor --adapter command` 检查配置；`smoke` 会实际调用一次模型。

该命令必须从标准输入读取完整提示，并且只把最终答案写到标准输出。优化器和评审器必须返回程序要求的 JSON；诊断日志应写到标准错误。命令以 `shell: false` 启动，不解释管道、重定向等 shell 语法。

## 工作流程和文件

`agents/` 保存优化器、执行器、评审器的独立提示。控制器通过独立 Codex 进程按顺序调用角色，不依赖桌面应用的自定义子代理配置。

原版开发集与回归集评估 → 修改候选 → 候选开发集与回归集评估 → 达标后冻结候选 → 原版和候选各执行一次保留集 → 达标后输出候选。

优化器只收到需求、开发集和开发反馈。保留集失败后本次运行停止，不再据此修改。回归失败时继续迭代也只提供开发反馈。

- `runs/每次运行/`：输入快照、版本、原始 JSONL 事件、每次响应、评分证据、耗时以及 `report.md`、`report.json`。
- `final/每次运行/candidate-skill/SKILL.md`：通过门槛的候选版，不覆盖原版、不自动安装到全局 Skill 目录。
- 运行失败时保存 `error.json`；退出码 1 表示运行错误，2 表示未达到质量门槛。

## 当前范围

这是文本型 Skill 的本地 MVP。运行器把 SKILL.md 正文直接注入任务，不验证自动触发准确率，也不执行 Skill 附带脚本、读取引用文件或检查 Word/PDF 等产物。带资源的 Skill 需要扩展运行器后再评估，不能仅复制正文就声称完整验证。

角色提示要求不使用工具，Codex 使用只读沙箱。独立工作目录与提示隔离并不是安全意义上的数据保密隔离：只读进程仍可能读取其他本机文件，用户配置中的工具也可能可用。需要严格保留集保密时，应使用独立账号或容器，只挂载该角色允许看到的文件。

示例只有四条案例，适合验证流程。正式比较应扩充任务分布、重复抽样并进行人工复核；若已经查看保留集结果并据此改进，下一次验收应换一套未使用的保留集。原始输出可能包含输入中的私人信息，运行目录默认被 Git 忽略。

## 故障排查

- `codex` 找不到：将 Codex CLI 放到 PATH，或设置 `CODEX_BIN` 为真实可执行文件的绝对路径；Windows 支持 `.exe`，不使用 shell 执行 `.cmd`。
- 未登录：运行 `codex login`。
- `Could not find home directory`：通常是受限执行环境无法读取用户目录；在本机终端运行上述命令，或在 Codex 中按提示批准真实调用。
- 模型不可用：用 `--model` 选择账号可用模型。
- 超时或连接失败：查看该次调用的 `stderr.log` 和 `trace.jsonl`，程序不会自动重复付费请求。

Codex 调用方式依据 [OpenAI 官方非交互运行文档](https://learn.chatgpt.com/docs/non-interactive-mode)：`codex exec --json`、`--output-schema` 和 `--output-last-message`。本机已核对 CLI 帮助，未沿用旧对话中未经验证的子代理 TOML 配置。
