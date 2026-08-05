@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set TICHY=0
if /i "%~1"=="--tichy" set TICHY=1

rem Zkusime "py" (oficialni Python launcher), potom "python".
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m monitor %*
    goto konec
)
python -V >nul 2>nul
if %errorlevel%==0 (
    python -m monitor %*
    goto konec
)

echo.
echo Python nebyl nalezen. Nainstaluj ho BEZ admin prav takto:
echo   1. Stahni instalator z https://www.python.org/downloads/
echo   2. V instalatoru NEzaskrtavej "Use admin privileges when installing",
echo      zaskrtni "Add python.exe to PATH" a klikni "Install Now".
echo   3. Spust tento soubor znovu.
echo Podrobny navod je v README.md.

:konec
if "%TICHY%"=="0" pause
endlocal
