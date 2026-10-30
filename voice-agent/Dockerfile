FROM python:3.11-slim

WORKDIR /app

# Install system deps for audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py tts_sanitize.py ./
# Do NOT bake .env into the image — it would freeze the gateway URL to
# `localhost` (broken from a container) and ship secrets in image layers.
# The compose file's `environment:` block is the single source of truth
# for runtime config; for local non-docker dev `python-dotenv` still picks
# up a sibling .env on disk.

CMD ["python", "agent.py", "start"]
