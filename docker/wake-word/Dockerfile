# InfiniBot Wake Word Server
# Fully local, multiple wake words, WebSocket API

FROM python:3.10-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (pinned for compatibility)
RUN pip install --no-cache-dir \
    numpy==1.26.4 \
    openwakeword \
    websockets

# Download models - openwakeword downloads on first use, so just preload
RUN python -c "import openwakeword; openwakeword.utils.download_models()"

# Copy server code
COPY server.py /app/

# Expose WebSocket port
EXPOSE 8765

# Environment vars
ENV WAKE_WORDS="hey_jarvis,alexa,hey_mycroft"
ENV THRESHOLD="0.5"
ENV PORT="8765"

CMD ["python", "server.py"]
