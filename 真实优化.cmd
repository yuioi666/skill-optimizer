@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo 请把 inputs 下的任务文件夹拖到这个文件上运行。
  echo 示例：真实优化.cmd inputs\my-skill
  pause
  exit /b 1
)
node scripts\cli.mjs run --job "%~1" --adapter configured --models config\models.local.json --iterations 1
pause
