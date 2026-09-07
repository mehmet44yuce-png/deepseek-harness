@echo off
setlocal
cd /d "%~dp0.."

set "DSH_PORT=3080"
set "DSH_LOG_DIR=%USERPROFILE%\.dsh\logs"
set "DSH_LOG=%DSH_LOG_DIR%\start-web.log"
if not exist "%DSH_LOG_DIR%" mkdir "%DSH_LOG_DIR%" >nul 2>&1

rem If the server is already running, only open the browser and exit.
netstat -ano | findstr ":%DSH_PORT%" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-web-when-ready.ps1" -Port %DSH_PORT% -LogPath "%DSH_LOG%" -TimeoutSeconds 5
  exit /b 0
)

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [HATA] node PATH uzerinde bulunamadi. Node.js kurulu mu?
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem Preflight. One bad plugin entry aborts the whole tree and the server never
rem binds the port, which shows up in the browser as a chat that cannot start.
rem Catching it here turns a silent crash into a readable message.
rem ---------------------------------------------------------------------------
echo [1/2] Yapilandirma kontrolu...
node "%~dp0preflight-web.mjs" web
if %errorlevel% neq 0 (
  echo.
  echo Yapilandirma dosyasi: %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
  echo Yukaridaki HATA satirlarini duzeltmeden sunucu acilmaz.
  pause
  exit /b 1
)

rem Keep the previous run's log for comparison when something regresses.
if exist "%DSH_LOG%" move /y "%DSH_LOG%" "%DSH_LOG%.prev" >nul 2>&1

echo [2/2] Sunucu baslatiliyor...
echo.
echo        Ilk acilis 1-2 dakika surebilir, asagida akan satirlar normaldir.
echo        Tarayici hazir olunca kendiliginden acilacak - BEKLEYIN.
echo        Bu pencere acik kaldigi surece sunucu calisir; kapatmak icin Ctrl+C.
echo        Log: %DSH_LOG%
echo.

rem `--no-open` plus our own opener: dsh's built-in open and a second opener here
rem would race and produce two tabs, and only this one is guaranteed to use the
rem tokenised URL from the log (a token-less URL just answers 401).
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-web-when-ready.ps1" -Port %DSH_PORT% -LogPath "%DSH_LOG%" -TimeoutSeconds 300

node "%~dp0run-and-log.mjs" "%DSH_LOG%" pnpm dsh web --no-open
set "DSH_RC=%errorlevel%"

rem 3221225786 = 0xC000013A, the console's Ctrl+C code: a deliberate stop, not a fault.
if "%DSH_RC%"=="3221225786" (
  echo.
  echo Sunucu Ctrl+C ile durduruldu.
  exit /b 0
)

if not "%DSH_RC%"=="0" (
  echo.
  echo ===============================================================
  echo [HATA] dsh web %DSH_RC% kodu ile sonlandi. Log'un son satirlari:
  echo ===============================================================
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Tail 40 -LiteralPath '%DSH_LOG%'"
  echo ===============================================================
  echo Tam log     : %DSH_LOG%
  echo Onceki log  : %DSH_LOG%.prev
  echo Profil      : %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
  echo Ayarlar     : %USERPROFILE%\.dsh\settings.yaml
  pause
)

exit /b %DSH_RC%
