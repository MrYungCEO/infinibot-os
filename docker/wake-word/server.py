#!/usr/bin/env python3
"""
InfiniBot Wake Word Server
WebSocket server for real-time wake word detection using OpenWakeWord.
Fully local, no internet required.

Protocol:
- Client sends binary audio data (16kHz 16-bit PCM)
- Client can send JSON config: {"type": "config", "wake_words": [...], "threshold": 0.5}
- Server sends JSON events: {"event": "wake_detected", "wake_word": "...", "confidence": 0.xx}
"""

import asyncio
import json
import os
import numpy as np
import websockets
from openwakeword.model import Model

# Configuration from environment
WAKE_WORDS = os.environ.get("WAKE_WORDS", "hey_jarvis,alexa,hey_mycroft").split(",")
THRESHOLD = float(os.environ.get("THRESHOLD", "0.5"))
PORT = int(os.environ.get("PORT", "8765"))

print(f"""
🎤 InfiniBot Wake Word Server
   Wake words: {WAKE_WORDS}
   Threshold: {THRESHOLD}
   Port: {PORT}
""")

print("Loading models...")

# Initialize wake word model with all available models
# We'll filter by active wake words per-client
oww_model = Model(
    wakeword_models=WAKE_WORDS,
    inference_framework="onnx"
)

print(f"✓ Models loaded: {list(oww_model.models.keys())}")

# Store per-client configurations
client_configs = {}

async def handle_client(websocket, path=None):
    """Handle a WebSocket client connection."""
    client_id = id(websocket)
    
    # Default client config
    client_configs[client_id] = {
        'wake_words': WAKE_WORDS.copy(),
        'threshold': THRESHOLD,
    }
    
    print(f"[{client_id}] Client connected")
    
    # Send ready event with available wake words
    await websocket.send(json.dumps({
        "event": "ready",
        "wake_words": list(oww_model.models.keys()),
        "threshold": THRESHOLD,
    }))
    
    # Audio buffer for accumulating samples
    audio_buffer = np.array([], dtype=np.int16)
    chunk_size = 1280  # ~80ms at 16kHz
    
    try:
        async for message in websocket:
            # Check if it's a config message (JSON)
            if isinstance(message, str):
                try:
                    data = json.loads(message)
                    if data.get('type') == 'config':
                        # Update client configuration
                        if 'wake_words' in data:
                            client_configs[client_id]['wake_words'] = data['wake_words']
                            print(f"[{client_id}] Updated wake words: {data['wake_words']}")
                        if 'threshold' in data:
                            client_configs[client_id]['threshold'] = float(data['threshold'])
                            print(f"[{client_id}] Updated threshold: {data['threshold']}")
                        
                        # Acknowledge config update
                        await websocket.send(json.dumps({
                            "event": "config_updated",
                            "wake_words": client_configs[client_id]['wake_words'],
                            "threshold": client_configs[client_id]['threshold'],
                        }))
                except json.JSONDecodeError:
                    pass
                continue
            
            # Binary audio data
            audio_chunk = np.frombuffer(message, dtype=np.int16)
            audio_buffer = np.concatenate([audio_buffer, audio_chunk])
            
            # Track chunks for periodic logging
            if not hasattr(handle_client, 'chunk_count'):
                handle_client.chunk_count = {}
            if client_id not in handle_client.chunk_count:
                handle_client.chunk_count[client_id] = 0
            handle_client.chunk_count[client_id] += 1
            
            # Process when we have enough samples
            while len(audio_buffer) >= chunk_size:
                # Extract chunk and convert to float
                chunk = audio_buffer[:chunk_size].astype(np.float32) / 32768.0
                audio_buffer = audio_buffer[chunk_size:]
                
                # Run prediction
                prediction = oww_model.predict(chunk)
                
                # Log scores periodically (every ~5 seconds)
                if handle_client.chunk_count[client_id] % 60 == 0:
                    scores_str = ", ".join([f"{k}: {v[-1] if isinstance(v, (list, np.ndarray)) and len(v) > 0 else v:.3f}" 
                                           for k, v in prediction.items()])
                    print(f"[{client_id}] Scores: {scores_str}")
                
                # Check each wake word for this client
                client_cfg = client_configs.get(client_id, {})
                client_wake_words = client_cfg.get('wake_words', WAKE_WORDS)
                client_threshold = client_cfg.get('threshold', THRESHOLD)
                
                for wake_word, scores in prediction.items():
                    # Skip if client doesn't want this wake word
                    if wake_word not in client_wake_words:
                        # Also check normalized versions
                        normalized = wake_word.replace('_v0.1', '').replace('_', ' ').lower()
                        if not any(w.replace('_', ' ').lower() in normalized or normalized in w.replace('_', ' ').lower() 
                                   for w in client_wake_words):
                            continue
                    
                    # Get the latest score
                    if isinstance(scores, (list, np.ndarray)):
                        score = float(scores[-1]) if len(scores) > 0 else 0.0
                    else:
                        score = float(scores)
                    
                    # Check threshold
                    if score >= client_threshold:
                        # Clean up wake word name
                        clean_name = wake_word.replace('_v0.1', '').replace('.tflite', '').replace('.onnx', '')
                        
                        print(f"[{client_id}] ✓ Wake word detected: {clean_name} (confidence: {score:.2f})")
                        
                        # Send detection event
                        await websocket.send(json.dumps({
                            "event": "wake_detected",
                            "wake_word": clean_name,
                            "confidence": round(score, 3),
                        }))
                        
                        # Reset the model to prevent repeated triggers
                        oww_model.reset()
                        break
                        
    except websockets.exceptions.ConnectionClosed:
        print(f"[{client_id}] Client disconnected")
    except Exception as e:
        print(f"[{client_id}] Error: {e}")
        try:
            await websocket.send(json.dumps({
                "event": "error",
                "message": str(e),
            }))
        except:
            pass
    finally:
        # Clean up client config
        if client_id in client_configs:
            del client_configs[client_id]

async def main():
    """Start the WebSocket server."""
    print(f"Starting WebSocket server on port {PORT}...")
    
    async with websockets.serve(
        handle_client,
        "0.0.0.0",
        PORT,
        ping_interval=30,
        ping_timeout=10,
        max_size=None,  # No message size limit for audio
    ):
        print(f"✓ Server listening on ws://0.0.0.0:{PORT}")
        print("Ready for connections!")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    asyncio.run(main())
