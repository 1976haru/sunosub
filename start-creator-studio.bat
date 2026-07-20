@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "KEYFILE=%~dp0.gemini_key"
set "PORT=5300"

echo ============================================
echo   Creator Studio Launcher
echo ============================================
echo.

if not exist "package.json" (
    echo ERROR: package.json not found in this folder.
    echo Put this .bat file in the creator-studio folder
    echo the folder that contains package.json
    echo.
    pause
    exit /b 1
)

if exist "%KEYFILE%" (
    set /p GEMINI_API_KEY=<"%KEYFILE%"
    echo [KEY] Using saved Gemini API key.
) else (
    echo [KEY] No saved Gemini API key found.
    echo       Free key, no billing required: https://aistudio.google.com/apikey
    echo.
    echo       Paste your Gemini API key and press Enter,
    echo       or press Enter to skip and run without a key.
    echo.
    set /p "NEWKEY=Key: "
    if "!NEWKEY!"=="" (
        echo.
        echo  No key entered. Starting without Gemini features.
        echo  You can add a key later from the app's "Change Key" button.
        echo.
    ) else (
        >"%KEYFILE%" echo !NEWKEY!
        set "GEMINI_API_KEY=!NEWKEY!"
        echo  Key saved to .gemini_key. It will be used automatically next time.
    )
)
echo.

if not exist "node_modules" (
    echo [1/2] Installing server packages ^(first run only^) ...
    call npm install
    if errorlevel 1 (
        echo.
        echo  npm install failed. See the error above.
        echo.
        pause
        exit /b 1
    )
) else (
    echo [1/2] Server packages already installed.
)

if exist "tools\storyboard\index.html" (
    echo [2/2] Storyboard build already present.
) else (
    echo [2/2] Building storyboard tool ^(first run only^) ...
    pushd storyboard-app
    call npm install
    if errorlevel 1 (
        echo.
        echo  storyboard-app npm install failed. See the error above.
        echo.
        popd
        pause
        exit /b 1
    )
    call npm run build
    if errorlevel 1 (
        echo.
        echo  storyboard-app build failed. See the error above.
        echo.
        popd
        pause
        exit /b 1
    )
    popd
)

echo.
if defined GEMINI_API_KEY (
    echo Ready ^(Gemini features ENABLED^). Starting server...
) else (
    echo Ready ^(no key, limited mode^). Starting server...
)
echo.
echo Keep this window open while you work. Closing it stops the app.
echo.

REM Give the server a couple seconds to start before opening the browser.
start "" /min cmd /c "ping 127.0.0.1 -n 3 >nul & start http://localhost:%PORT%"
call npm start

pause
