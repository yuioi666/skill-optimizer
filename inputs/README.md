# 自定义评估任务

`examples/` 只用于演示。请把自己的任务放在这里，每个任务使用独立目录：

```text
inputs/
└─ my-skill/
   ├─ original-skill/
   │  └─ SKILL.md
   ├─ job.json
   ├─ development.jsonl
   ├─ regression.jsonl
   └─ holdout.jsonl
```

可以从演示任务复制一份结构：

```powershell
Copy-Item examples/meeting-summary inputs/my-skill -Recurse
```

修改 Skill、配置和测试案例后运行：

```powershell
node scripts/cli.mjs validate --job inputs/my-skill
npm run optimize -- --job inputs/my-skill --iterations 1
```

当前版本只评估 `SKILL.md` 的文本行为，不会执行 Skill 附带脚本或测试外部项目。`inputs/` 下除本说明外的内容默认被 Git 忽略。
