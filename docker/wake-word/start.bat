@echo off
echo ========================================
echo   InfiniBot Wake Word Server (Docker)
echo ========================================
echo.
echo Building and starting container...
cd /d "%~dp0"
docker-compose up --build -d
echo.
echo ✓ Wake Word Server running at ws://localhost:8765
echo   Wake words: hey_jarvis, alexa, hey_mycroft
echo.
echo To view logs: docker logs -f infinibot-wake-word
echo To stop: docker-compose down
pause
