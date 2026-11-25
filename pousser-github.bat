@echo off
cd /d "%~dp0"
git push origin main > "%~dp0push-result.txt" 2>&1
echo Fini. >> "%~dp0push-result.txt"
