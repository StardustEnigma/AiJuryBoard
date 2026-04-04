@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"

if exist ".env" (
  echo Loading environment from .env ...
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if not "%%~A"=="" (
      set "%%~A=%%~B"
    )
  )
) else (
  echo WARNING: .env not found in repo root. Starting with current environment only.
)

echo Starting AI Jury backend orchestrator...
start "AI Jury Backend" cmd /k "cd /d ""%~dp0jury-room-backend\orchestrator"" && npm run dev"

echo Starting AI Jury frontend...
start "AI Jury Frontend" cmd /k "cd /d ""%~dp0ai-jury-frontend"" && npm run dev -- --host 0.0.0.0 --port 5173"

echo.
echo Launched both services:
echo   Backend health: http://localhost:9000/health
echo   Frontend app : http://localhost:5173/
echo.
echo Close this window anytime. Service terminals stay open.
