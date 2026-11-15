@echo off
title Guilherme Code Launcher
color 0A
cd /d "%~dp0"
if not exist node_modules\express (
  echo Instalando dependencias...
  call npm install
)
if not exist node_modules\pdfjs-dist (
  echo Instalando leitor de PDF ^(uma vez so^)...
  call npm install
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
:rodar
echo Iniciando o servidor do Guilherme Code...
node server.js
if errorlevel 1 (
  echo.
  echo [Supervisor] O servidor parou com erro. Reiniciando em 3 segundos... ^(feche esta janela para parar^)
  timeout /t 3 >nul
  goto rodar
)
pause
