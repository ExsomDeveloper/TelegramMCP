@echo off
chcp 65001 >nul
title Telegram MCP
cd /d "%~dp0.."

curl -s -o nul -m 2 http://127.0.0.1:8787/health
if not errorlevel 1 (
  echo Демон уже запущен ^(порт 8787 занят^).
  pause
  exit /b
)

if not exist dist\index.js (
  echo Сборка проекта...
  call npm run build || (pause & exit /b 1)
)

echo Telegram MCP запущен. Закройте окно, чтобы остановить.
echo.
node dist\index.js
echo.
echo Демон остановлен.
pause
