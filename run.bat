@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ================================================
echo   Video Clipper - one-click setup and start
echo ================================================
echo.

REM ---------- 1. Python ----------
where python >nul 2>nul
if errorlevel 1 (
    echo [1/4] Python not found.
    where winget >nul 2>nul
    if errorlevel 1 (
        echo Please install Python 3.8+ manually from https://python.org/downloads
        echo then re-run this script.
        pause
        exit /b 1
    )
    echo Installing Python via winget - this may take a minute...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    echo.
    echo Python was just installed. Please CLOSE this window, open a NEW
    echo Command Prompt, and double-click run.bat again so it can pick up
    echo the updated PATH.
    pause
    exit /b 0
) else (
    echo [1/4] Python found.
)

REM ---------- 2. ffmpeg ----------
where ffmpeg >nul 2>nul
if errorlevel 1 (
    if exist "ffmpeg_bin\ffmpeg.exe" (
        echo [2/4] Using previously downloaded ffmpeg.
        set "PATH=%cd%\ffmpeg_bin;%PATH%"
    ) else (
        where winget >nul 2>nul
        if not errorlevel 1 (
            echo [2/4] Installing ffmpeg via winget...
            winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
            where ffmpeg >nul 2>nul
            if errorlevel 1 (
                echo ffmpeg was installed but this window does not see it on PATH yet.
                echo Please close this window, open a NEW Command Prompt, and
                echo double-click run.bat again.
                pause
                exit /b 0
            )
        ) else (
            echo [2/4] Downloading a portable copy of ffmpeg, this may take a few minutes...
            powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'ffmpeg_download.zip'"
            if not exist ffmpeg_download.zip (
                echo Could not download ffmpeg automatically.
                echo Please install it manually from https://ffmpeg.org/download.html
                echo and re-run run.bat.
                pause
                exit /b 1
            )
            powershell -NoProfile -Command "Expand-Archive -Path 'ffmpeg_download.zip' -DestinationPath 'ffmpeg_extract' -Force"
            if not exist ffmpeg_bin mkdir ffmpeg_bin
            for /d %%i in (ffmpeg_extract\ffmpeg-*) do copy "%%i\bin\ffmpeg.exe" "ffmpeg_bin\" >nul
            del ffmpeg_download.zip
            rd /s /q ffmpeg_extract
            set "PATH=%cd%\ffmpeg_bin;%PATH%"
        )
    )
) else (
    echo [2/4] ffmpeg found.
)

REM ---------- 3. Virtual environment + dependencies ----------
if not exist venv (
    echo [3/4] Creating Python virtual environment...
    python -m venv venv
)
call venv\Scripts\activate.bat
echo [3/4] Installing Python dependencies...
python -m pip install --quiet --disable-pip-version-check --upgrade pip
python -m pip install --quiet --disable-pip-version-check -r requirements.txt

REM ---------- 4. Run ----------
echo [4/4] Starting Video Clipper...
echo Your browser will open automatically at http://localhost:5000
echo Keep this window open while using the app. Press Ctrl+C here to stop it.
echo.
start "" cmd /c "timeout /t 3 >nul && start http://localhost:5000"
python app.py

pause
