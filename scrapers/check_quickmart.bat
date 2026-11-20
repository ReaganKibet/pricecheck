@echo off
rem Dry run of the Quickmart connector: reads 8 product pages, sends nothing.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONDONTWRITEBYTECODE=1
set PYTHONUNBUFFERED=1
set PY=
if exist "%USERPROFILE%\anaconda3\python.exe" set PY="%USERPROFILE%\anaconda3\python.exe"
if not defined PY (where py >nul 2>nul && set PY=py)
if not defined PY (where python >nul 2>nul && set PY=python)
%PY% -m pricecheck_connectors run quickmart_site --mode discover --dry-run --limit 8 > check_results.txt 2>&1
echo Done. Results saved to check_results.txt
timeout /t 10
