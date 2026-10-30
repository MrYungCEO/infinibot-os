@echo off
title InfiniBot Desktop
cd /d "%~dp0"

:: Add npm global bin to PATH
set PATH=%PATH%;%APPDATA%\npm

:: Gateway configuration
set INFINIBOT_GATEWAY_HOST=127.0.0.1
set INFINIBOT_GATEWAY_PORT=18789
:: Set INFINIBOT_PASSWORD in your user environment, not here.
:: Example: setx INFINIBOT_PASSWORD "your-strong-password"

:: STT Server (local or tunnel)
set INFINIBOT_STT_URL=http://localhost:8765/api/stt

:: Run Electron
electron .
