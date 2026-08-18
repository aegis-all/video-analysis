@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo 動画レビュー のサーバーを停止します...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"