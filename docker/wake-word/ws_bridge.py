"""
WebSocket Bridge for Wyoming-OpenWakeWord
Accepts audio from browser, sends to Wyoming, returns wake events.
"""

import asyncio
import json
import os
import struct

import websockets

WYOMING_HOST = os.environ.get("WYOMING_HOST", "wake-word")
WYOMING_PORT = int(os.environ.get("WYOMING_PORT", "10400"))
WS_PORT = int(os.environ.get("WS_PORT", "8765"))

async def handle_client(websocket, path):
    """Handle browser WebSocket connection"""
    print(f"[Bridge] Client connected")
    
    # Send ready event
    await websocket.send(json.dumps({
        "event": "ready",
        "wake_words": ["hey_jarvis", "alexa", "hey_mycroft"],
        "threshold": 0.5
    }))
    
    try:
        # Connect to Wyoming service
        reader, writer = await asyncio.open_connection(WYOMING_HOST, WYOMING_PORT)
        print(f"[Bridge] Connected to Wyoming at {WYOMING_HOST}:{WYOMING_PORT}")
        
        async def forward_audio():
            """Forward audio from browser to Wyoming"""
            async for message in websocket:
                if isinstance(message, bytes):
                    # Wyoming expects specific format - wrap audio chunk
                    # Format: JSON header + raw audio
                    header = json.dumps({
                        "type": "audio-chunk",
                        "data": {
                            "rate": 16000,
                            "width": 2,
                            "channels": 1
                        }
                    })
                    header_bytes = header.encode("utf-8")
                    writer.write(struct.pack(">I", len(header_bytes)))
                    writer.write(header_bytes)
                    writer.write(struct.pack(">I", len(message)))
                    writer.write(message)
                    await writer.drain()
        
        async def receive_events():
            """Receive wake events from Wyoming"""
            while True:
                try:
                    # Read header length
                    header_len_bytes = await reader.read(4)
                    if not header_len_bytes:
                        break
                    header_len = struct.unpack(">I", header_len_bytes)[0]
                    
                    # Read header
                    header_bytes = await reader.read(header_len)
                    header = json.loads(header_bytes.decode("utf-8"))
                    
                    # Read payload if present
                    payload_len_bytes = await reader.read(4)
                    payload_len = struct.unpack(">I", payload_len_bytes)[0]
                    if payload_len > 0:
                        payload = await reader.read(payload_len)
                    
                    # Check for detection
                    if header.get("type") == "detection":
                        wake_word = header.get("data", {}).get("name", "unknown")
                        print(f"[Bridge] ✓ Wake word detected: {wake_word}")
                        await websocket.send(json.dumps({
                            "event": "wake_detected",
                            "wake_word": wake_word,
                            "confidence": 1.0
                        }))
                        
                except Exception as e:
                    print(f"[Bridge] Wyoming read error: {e}")
                    break
        
        # Run both tasks
        await asyncio.gather(forward_audio(), receive_events())
        
    except Exception as e:
        print(f"[Bridge] Error: {e}")
    finally:
        print(f"[Bridge] Client disconnected")

async def main():
    print(f"🎤 Wake Word WebSocket Bridge")
    print(f"   WebSocket: ws://0.0.0.0:{WS_PORT}")
    print(f"   Wyoming: {WYOMING_HOST}:{WYOMING_PORT}")
    
    async with websockets.serve(handle_client, "0.0.0.0", WS_PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
