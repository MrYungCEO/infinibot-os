@echo off
echo ========================================
echo   InfiniBot Local Voice Services
echo   - Wake Word (Docker OpenWakeWord)
echo   - Transcription (Docker Whisper)
echo ========================================
echo.

cd /d "C:\Users\Admin\Desktop\CLAWDBOT\infinibot"

echo [1/2] Starting Docker Whisper container...
docker start voiceserver-whisper-1 2>nul || echo       (Already running or not found)
echo       Whisper: http://localhost:11435
echo.

echo [2/2] Starting Docker Wake Word container...
cd docker\wake-word
docker-compose up -d --build 2>nul
cd ..\..
echo       Wake Word: ws://localhost:8765
echo.

echo ========================================
echo   Both servers running in Docker!
echo   
echo   Wake words: hey_jarvis, alexa, hey_mycroft
echo   
echo   To view logs:
echo     docker logs -f infinibot-wake-word
echo     docker logs -f voiceserver-whisper-1
echo   
echo   To stop:
echo     docker stop infinibot-wake-word voiceserver-whisper-1
echo ========================================
echo.
pause
