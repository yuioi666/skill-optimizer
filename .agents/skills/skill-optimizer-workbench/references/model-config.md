# 模型配置

本地模型配置为 `config/models.local.json`。如果不存在，从 `config/models.example.json` 复制。该文件包含 API Key，不得提交 Git。

`providers` 定义连接，`roles` 为 `runner`、`optimizer`、`evaluator` 分别选择 provider 和 model。同一 provider 可以被多个角色复用。

支持类型：

- `codex`：使用本机已登录的 Codex CLI。
- `openai-compatible`：调用 `{baseUrl}/chat/completions`。
- `anthropic`：调用 Anthropic Messages API。
- `command`：通过标准输入输出调用本机模型命令。

优先使用环境变量或本地密钥文件。不得在已提交文件、任务配置、提示词或报告中记录 API Key。
