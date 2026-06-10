@echo off
title Vibe Forge - dev server (keep this window open while you use the app)
cd /d "%~dp0"
echo.
echo   Starting Vibe Forge...  Leave this window open.
echo   Then launch the installed "Vibe Forge" app, or open http://localhost:5173
echo.
call npm run dev
echo.
echo   Vibe Forge stopped. Press any key to close.
pause >nul
