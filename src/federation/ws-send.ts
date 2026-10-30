import { type WebSocket } from "ws";

export function sendWebSocketMessage(socket: WebSocket, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // ws.send reports mid-send socket errors only through this callback.
    socket.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
