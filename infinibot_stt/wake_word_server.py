"""
Porcupine Wake Word Server for InfiniBot
Lightweight, reliable wake word detection for Windows.

Requires: pip install pvporcupine websockets numpy

Run: python -m infinibot_stt.wake_word_server
Connects at: ws://localhost:8765/wake
"""

import asyncio
import json
import sys
import os
import struct

try:
    import numpy as np
except ImportError:
    print("ERROR: numpy not installed. Run: pip install numpy")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("ERROR: websockets not installed. Run: pip install websockets")
    sys.exit(1)

try:
    import pvporcupine
except ImportError:
    print("ERROR: pvporcupine not installed. Run: pip install pvporcupine")
    sys.exit(1)

# Configuration  
PORT = 8765
THRESHOLD = 0.5

# Get access key from environment or use demo
ACCESS_KEY = os.environ.get("PICOVOICE_ACCESS_KEY", "")

# Available built-in wake words: alexa, americano, blueberry, bumblebee, computer,
# grapefruit, grasshopper, hey barista, hey google, hey siri, jarvis, ok google,
# picovoice, porcupine, terminator
WAKE_WORD = "jarvis"  # Using "jarvis" as closest to "ash"

print(f"🎤 Porcupine Wake Word Server")
print(f"   Wake word: '{WAKE_WORD}'")

# Initialize Porcupine
try:
    if ACCESS_KEY:
        porcupine = pvporcupine.create(
            access_key=ACCESS_KEY,
            keywords=[WAKE_WORD]
        )
    else:
        # Try demo/built-in mode
        porcupine = pvporcupine.create(
            keywords=[WAKE_WORD]
        )
    print(f"✓ Porcupine initialized (sample rate: {porcupine.sample_rate}Hz, frame length: {porcupine.frame_length})")
except pvporcupine.PorcupineActivationError:
    print("\n⚠️  Porcupine requires a free API key from Picovoice.")
    print("   1. Sign up at: https://console.picovoice.ai/")
    print("   2. Get your Access Key")
    print("   3. Set environment variable: PICOVOICE_ACCESS_KEY=your_key")
    print("   Or run: set PICOVOICE_ACCESS_KEY=your_key")
    sys.exit(1)
except Exception as e:
    print(f"Error initializing Porcupine: {e}")
    sys.exit(1)

async def handle_client(websocket, path):
    """Handle a single WebSocket client"""
    client_id = id(websocket)
    print(f"[WakeWord] Client {client_id} connected")
    
    # Send ready event
    await websocket.send(json.dumps({
        "event": "ready",
        "wake_word": WAKE_WORD,
        "sample_rate": porcupine.sample_rate,
        "frame_length": porcupine.frame_length
    }))
    
    # Audio buffer
    audio_buffer = np.array([], dtype=np.int16)
    frame_length = porcupine.frame_length
    
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Convert bytes to numpy array (int16)
                audio_chunk = np.frombuffer(message, dtype=np.int16)
                audio_buffer = np.concatenate([audio_buffer, audio_chunk])
                
                # Process complete frames
                while len(audio_buffer) >= frame_length:
                    frame = audio_buffer[:frame_length]
                    audio_buffer = audio_buffer[frame_length:]
                    
                    # Run detection
                    keyword_index = porcupine.process(frame)
                    
                    if keyword_index >= 0:
                        print(f"[WakeWord] ✓ Detected '{WAKE_WORD}'!")
                        await websocket.send(json.dumps({
                            "event": "wake_detected",
                            "wake_word": WAKE_WORD,
                            "confidence": 1.0
                        }))
                        
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print(f"[WakeWord] Client {client_id} disconnected")

async def main():
    print(f"\n🎤 Wake Word Server running on ws://localhost:{PORT}/wake")
    print(f"   Say '{WAKE_WORD.upper()}' to trigger")
    print(f"   Waiting for connections...\n")
    
    async with websockets.serve(handle_client, "0.0.0.0", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        if 'porcupine' in dir():
            porcupine.delete()
