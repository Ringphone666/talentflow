@echo off
rem Start the platform as a single service (API + built web pages) on this machine.
rem See README.md for configuration. Messages are kept in ASCII so they display on any console code page.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Python environment not found. Run:  python -m venv .venv  and install backend\requirements.txt
  pause
  exit /b 1
)
if not exist ".env" (
  echo [WARN] .env not found. Model services will be unavailable. Copy .env.example to .env and fill it in.
)
if not exist "frontend\dist\index.html" (
  echo [ERROR] Web pages are not built. Run:  cd frontend  ^&^&  npm install  ^&^&  npm run build
  pause
  exit /b 1
)

if "%TALENTFLOW_API_PORT%"=="" set TALENTFLOW_API_PORT=8000
echo Starting on http://127.0.0.1:%TALENTFLOW_API_PORT%/   (close this window to stop)
rem Open the browser a few seconds later, once the service is listening.
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start http://127.0.0.1:%TALENTFLOW_API_PORT%/"
".venv\Scripts\python.exe" scripts\serve_api.py %TALENTFLOW_API_PORT%
pause
