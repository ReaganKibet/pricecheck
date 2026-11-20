@echo off
rem Checks all four supermarket websites and saves what it finds to discover_results.txt
rem Double-click to run. Uses your normal internet connection.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONDONTWRITEBYTECODE=1
set PYTHONUNBUFFERED=1
set PY=
if exist "%USERPROFILE%\anaconda3\python.exe" set PY="%USERPROFILE%\anaconda3\python.exe"
if not defined PY (where py >nul 2>nul && set PY=py)
if not defined PY (where python >nul 2>nul && set PY=python)
if not defined PY (
  echo Python was not found. Install Python 3 from python.org and try again. > discover_results.txt
  type discover_results.txt
  pause
  exit /b 1
)
echo Checking store websites with %PY% ... this takes a few minutes.
(
  for %%S in (https://naivas.online https://www.carrefour.ke https://www.quickmart.co.ke https://foodplus.co.ke) do (
    echo.
    echo ==================== %%S
    %PY% -m pricecheck_connectors discover %%S --samples 4
  )
  echo.
  echo ==================== FINISHED
) > discover_results.txt 2>&1
echo Done. Results saved to discover_results.txt
timeout /t 10
