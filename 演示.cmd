@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\cli.mjs run --adapter mock
pause
