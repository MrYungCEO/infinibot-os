/**
 * useVideoStream — Hook for pushing camera frames to the gateway vision feed
 * 
 * Uses expo-camera to capture frames and sends each one with
 * `vision.pushFrame { dataUrl }`, so the agent's vision tools (vision.look)
 * can see what this device's camera sees.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

// Stream configuration defaults
const DEFAULT_CONFIG = {
  fps: 10,
  quality: 0.6,
  width: 640,
  height: 480,
};

export function useVideoStream(gateway) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [stats, setStats] = useState({ fps: 0, bitrate: 0, frames: 0 });
  const [error, setError] = useState(null);
  const [cameraType, setCameraType] = useState('back'); // 'back' | 'front'
  
  const cameraRef = useRef(null);
  const streamIntervalRef = useRef(null);
  const frameCountRef = useRef(0);
  const bytesSentRef = useRef(0);
  const lastStatsUpdateRef = useRef(Date.now());

  /**
   * Start streaming video to master
   */
  const startStream = useCallback(async (newConfig = {}) => {
    if (isStreaming) return;
    
    const mergedConfig = { ...config, ...newConfig };
    setConfig(mergedConfig);
    setError(null);
    setIsStreaming(true);
    setIsPaused(false);
    
    // Reset stats
    frameCountRef.current = 0;
    bytesSentRef.current = 0;
    lastStatsUpdateRef.current = Date.now();
    
    console.log('[VideoStream] Started with config:', mergedConfig);
    
    // Note: Actual frame capture happens in the VideoStreamView component
    // via the takePictureAsync method on the camera ref
  }, [config, isStreaming]);

  /**
   * Stop streaming
   */
  const stopStream = useCallback(() => {
    setIsStreaming(false);
    setIsPaused(false);
    
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
    }
    
    setStats({ fps: 0, bitrate: 0, frames: 0 });
    console.log('[VideoStream] Stopped');
  }, []);

  /**
   * Pause streaming (keep camera active)
   */
  const pauseStream = useCallback(() => {
    if (isStreaming) {
      setIsPaused(true);
      console.log('[VideoStream] Paused');
    }
  }, [isStreaming]);

  /**
   * Resume streaming
   */
  const resumeStream = useCallback(() => {
    if (isStreaming && isPaused) {
      setIsPaused(false);
      console.log('[VideoStream] Resumed');
    }
  }, [isStreaming, isPaused]);

  /**
   * Toggle camera (front/back)
   */
  const toggleCamera = useCallback(() => {
    setCameraType(prev => prev === 'back' ? 'front' : 'back');
    console.log('[VideoStream] Toggled camera');
  }, []);

  /**
   * Send a captured frame to the gateway
   */
  const sendFrame = useCallback(async (base64Data, mimeType = 'image/jpeg') => {
    if (!gateway?.sendReq || !isStreaming || isPaused) return;
    
    try {
      const frameSize = base64Data.length;
      
      // vision.pushFrame is the gateway's frame-ingest RPC: it takes a single
      // image data URL and makes it the current UI stream frame that
      // vision.look reads (src/gateway/server-methods/vision.ts).
      const mime = mimeType.includes('png') ? 'image/png' : 'image/jpeg';
      await gateway.sendReq('vision.pushFrame', {
        dataUrl: `data:${mime};base64,${base64Data}`,
      });
      setError(null);

      // Update stats
      frameCountRef.current++;
      bytesSentRef.current += frameSize;
      
      const now = Date.now();
      const elapsed = now - lastStatsUpdateRef.current;
      
      if (elapsed >= 1000) {
        const fps = Math.round(frameCountRef.current / (elapsed / 1000));
        const bitrate = Math.round((bytesSentRef.current * 8) / elapsed); // kbps
        
        setStats({
          fps,
          bitrate,
          frames: frameCountRef.current,
        });
        
        frameCountRef.current = 0;
        bytesSentRef.current = 0;
        lastStatsUpdateRef.current = now;
      }
    } catch (err) {
      console.warn('[VideoStream] Frame send error:', err.message);
      setError(err.message);
    }
  }, [gateway, isStreaming, isPaused, config]);

  /**
   * Update stream configuration
   */
  const updateConfig = useCallback((newConfig) => {
    setConfig(prev => ({ ...prev, ...newConfig }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamIntervalRef.current) {
        clearInterval(streamIntervalRef.current);
      }
    };
  }, []);

  return {
    // State
    isStreaming,
    isPaused,
    config,
    stats,
    error,
    cameraType,
    cameraRef,
    
    // Actions
    startStream,
    stopStream,
    pauseStream,
    resumeStream,
    toggleCamera,
    sendFrame,
    updateConfig,
    
    // Computed
    isActive: isStreaming && !isPaused,
  };
}

export default useVideoStream;
