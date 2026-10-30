"""
InfiniBot Local STT Server
Uses faster-whisper for speech-to-text transcription.

Install dependencies:
  pip install faster-whisper fastapi uvicorn python-multipart

Run:
  python -m infinibot_stt.server
"""

import os
import sys
import tempfile
import asyncio
from pathlib import Path

# Check for required packages
try:
    from faster_whisper import WhisperModel
except ImportError:
    print("ERROR: faster-whisper not installed.")
    print("Run: pip install faster-whisper")
    sys.exit(1)

try:
    from fastapi import FastAPI, UploadFile, File, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    import uvicorn
except ImportError:
    print("ERROR: FastAPI/uvicorn not installed.")
    print("Run: pip install fastapi uvicorn python-multipart")
    sys.exit(1)

# Configuration
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")  # tiny, base, small, medium, large-v2
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")  # cpu or cuda
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")  # int8, float16, float32
PORT = int(os.environ.get("STT_PORT", "8766"))  # 8766 for STT, 8765 is wake word

print(f"Loading Whisper model: {MODEL_SIZE} (device={DEVICE}, compute={COMPUTE_TYPE})")
print("This may take a moment on first run (downloading model)...")

# Load model
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
print(f"Model loaded successfully!")

# Create FastAPI app
app = FastAPI(title="InfiniBot STT Server", version="1.0")

# CORS for browser access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}

@app.get("/health")
async def health():
    return {"status": "healthy", "model": MODEL_SIZE}

@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = None):
    """
    Transcribe an audio file.
    Accepts: wav, mp3, webm, ogg, m4a, flac
    Returns: { "text": "transcribed text", "segments": [...] }
    """
    # Save uploaded file temporarily
    suffix = Path(audio.filename).suffix if audio.filename else ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        # Transcribe
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            vad_filter=True,  # Filter out silence
        )
        
        # Collect results
        text_parts = []
        segment_list = []
        for segment in segments:
            text_parts.append(segment.text)
            segment_list.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            })
        
        full_text = " ".join(text_parts).strip()
        
        return {
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": segment_list,
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # Cleanup temp file
        try:
            os.unlink(tmp_path)
        except:
            pass

@app.post("/api/stt")
async def api_stt(audio: UploadFile = File(...)):
    """Alias endpoint for compatibility"""
    result = await transcribe(audio)
    return result

def main():
    print(f"\n🎤 InfiniBot STT Server starting on http://localhost:{PORT}")
    print(f"   POST /transcribe - Upload audio file for transcription")
    print(f"   GET /health - Health check\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

if __name__ == "__main__":
    main()
