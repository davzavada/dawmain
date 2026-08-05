@echo off
setlocal
cd /d "%~dp0"

rem Zaregistruje ulohu v Planovaci uloh Windows pro prihlaseneho uzivatele
rem - NEVYZADUJE admin prava. Rozvrh se ridi nastavenim "obdobi" a
rem "planovac" v config.json (mesicne / tydne / denne).

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m monitor nastav-planovac
    goto konec
)
python -V >nul 2>nul
if %errorlevel%==0 (
    python -m monitor nastav-planovac
    goto konec
)
echo Python nebyl nalezen - postup instalace bez admin prav je v README.md.

:konec
pause
endlocal
