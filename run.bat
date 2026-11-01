@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3.10+ belum terpasang. Install dari https://www.python.org/downloads/
    pause
    exit /b 1
  )
  set "PYTHON=python"
) else (
  set "PYTHON=py -3"
)
%PYTHON% -c "import requests" >nul 2>nul
if errorlevel 1 (
  echo Memasang dependency lokal...
  %PYTHON% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Instalasi dependency gagal.
    pause
    exit /b 1
  )
)
%PYTHON% val.py %*
if errorlevel 1 pause
