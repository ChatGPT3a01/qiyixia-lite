@echo off
chcp 65001 >nul 2>&1
title 起易蝦 - Portable AI Agent

echo.
echo   ========================================
echo     起易蝦 v1.1 - Portable AI Agent
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"

REM Migration shim: rename old core-win to core for existing USB users
if exist "%APP_DIR%\core-win" if not exist "%APP_DIR%\core" ren "%APP_DIR%\core-win" core

set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%APP_DIR%\runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"

REM Check runtime
if not exist "%NODE_BIN%" (
    echo   [ERROR] Node.js runtime not found
    echo   Please ensure app\runtime\node-win-x64 is complete
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Init data directories
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

REM First run: create config.env from example
if not exist "%DATA_DIR%\config.env" (
    if exist "%DATA_DIR%\config.env.example" (
        echo   First run - creating config.env from example...
        copy "%DATA_DIR%\config.env.example" "%DATA_DIR%\config.env" >nul
        echo   config.env created
        echo.
    )
)

REM Default config
if not exist "%STATE_DIR%\openclaw.json" (
    echo   First run - creating default config...
    echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}} > "%STATE_DIR%\openclaw.json"
    echo   Config created
    echo.
)

REM Sync config from legacy location
if exist "%DATA_DIR%\config.json" if not exist "%STATE_DIR%\openclaw.json" (
    copy "%DATA_DIR%\config.json" "%STATE_DIR%\openclaw.json" >nul
)

REM Check dependencies
if not exist "%CORE_DIR%\node_modules" (
    echo   First run - installing dependencies...
    echo   Using China mirror, please wait...
    echo.
    cd /d "%CORE_DIR%"
    call "%NPM_BIN%" install --registry=https://registry.npmmirror.com
    echo.
    echo   Dependencies installed!
    echo.
)

REM Find available port
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   Port %PORT% in use, trying next...
    set /a PORT+=1
    if %PORT% gtr 18799 (
        echo   No available port 18789-18799
        pause
        exit /b 1
    )
    goto :check_port
)

REM ---- Auth Check ----
echo   Checking license...
"%NODE_BIN%" "%~dp0app\auth.mjs" check "%~dp0data\config.env"
if %ERRORLEVEL% EQU 2 (
    echo.
    echo   [授權已到期] 請聯絡 3a01chatgpt@gmail.com 取得續約碼
    echo.
    set /p RENEWAL_CODE="  輸入續約碼（無則按 Enter 離開）: "
    if defined RENEWAL_CODE (
        "%NODE_BIN%" "%~dp0app\auth.mjs" apply-renewal "%~dp0data\config.env" "%RENEWAL_CODE%"
        if errorlevel 1 (
            echo   續約失敗。
            pause
            exit /b 1
        )
        echo   續約成功！
    ) else (
        echo   系統將關閉。
        pause
        exit /b 1
    )
)
if %ERRORLEVEL% EQU 1 (
    echo   [安全違規] DEVICE_TOKEN 被竄改，系統拒絕啟動。
    pause
    exit /b 1
)
echo   License OK
echo.

echo   Starting OpenClaw on port %PORT%...
echo.

REM ---- USB Heartbeat (every 5 minutes) ----
echo   Starting USB heartbeat monitor (5 min interval)...
for /f "tokens=*" %%T in ('"%NODE_BIN%" -e "const c=require('fs').readFileSync('%~dp0data\\config.env','utf-8');const m=c.match(/DEVICE_TOKEN=\"([^\"]+)\"/);if(m)process.stdout.write(m[1])"') do set DEVICE_TOKEN=%%T
if defined DEVICE_TOKEN (
    start /B "" "%NODE_BIN%" "%~dp0app\heartbeat.mjs" "%DEVICE_TOKEN%" "%~dp0data\config.env" 5 >nul 2>&1
    echo   Heartbeat started for token: %DEVICE_TOKEN:~0,8%...
) else (
    echo   [WARN] DEVICE_TOKEN not found, heartbeat skipped
)
echo.

REM Start Config Server in background
echo   Starting Config Center on port 18788...
set "CONFIG_SERVER=%UCLAW_DIR%config-server"
start /B "" "%NODE_BIN%" "%CONFIG_SERVER%\server.js" >nul 2>&1

REM Wait for config server to start
timeout /t 2 /nobreak >nul

REM Open both Dashboard and Config Center
echo   Opening Dashboard and Config Center...
timeout /t 1 /nobreak >nul

REM Open OpenClaw Dashboard first
start "" http://127.0.0.1:%PORT%/#token=uclaw

REM Open Config Center (Node.js web UI) second
start "" http://127.0.0.1:18788/

echo   Browsers opened. Starting OpenClaw Gateway on port %PORT%...
echo   DO NOT close this window while using 起易蝦!
echo.

cd /d "%CORE_DIR%"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port %PORT%

echo.
echo   OpenClaw stopped.
pause
