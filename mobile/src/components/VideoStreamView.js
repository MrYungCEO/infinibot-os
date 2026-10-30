/**
 * VideoStreamView — Camera streaming component
 * 
 * Captures camera frames and streams them to master device
 * via the gateway for real-time video feed.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Platform, Dimensions,
} from 'react-native';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function VideoStreamView({
  gateway,
  streamHook, // from useVideoStream
  showPreview = true,
  compact = false,
  style,
}) {
  const {
    isStreaming,
    isPaused,
    config,
    stats,
    error,
    cameraType,
    startStream,
    stopStream,
    pauseStream,
    resumeStream,
    toggleCamera,
    sendFrame,
    updateConfig,
    isActive,
  } = streamHook;

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const [cameraReady, setCameraReady] = useState(false);

  // Capture and send frames when streaming
  useEffect(() => {
    if (!isActive || !cameraReady || !cameraRef.current) {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      return;
    }

    const frameInterval = Math.floor(1000 / config.fps);
    
    frameIntervalRef.current = setInterval(async () => {
      if (!isActive || !cameraRef.current) return;
      
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: config.quality,
          base64: true,
          skipProcessing: true,
          exif: false,
        });
        
        if (photo?.base64) {
          sendFrame(photo.base64, 'image/jpeg');
        }
      } catch (err) {
        console.warn('[VideoStream] Capture error:', err.message);
      }
    }, frameInterval);

    return () => {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    };
  }, [isActive, cameraReady, config.fps, config.quality, sendFrame]);

  // Permission handling
  if (!permission) {
    return (
      <View style={[styles.container, styles.centerContent, style]}>
        <ActivityIndicator color={COLORS.primary} />
        <Text style={styles.permissionText}>Checking camera permission...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.centerContent, style]}>
        <Ionicons name="camera-outline" size={48} color={COLORS.textMuted} />
        <Text style={styles.permissionText}>Camera permission required</Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isConnected = gateway?.status === 'connected';

  return (
    <View style={[styles.container, style]}>
      {/* Camera Preview */}
      {showPreview && (isStreaming || isPaused) ? (
        <View style={styles.previewContainer}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing={cameraType}
            onCameraReady={() => setCameraReady(true)}
          />
          
          {/* Streaming indicator */}
          {isActive && (
            <View style={styles.streamingIndicator}>
              <View style={styles.recordDot} />
              <Text style={styles.streamingText}>LIVE</Text>
              <Text style={styles.statsText}>{stats.fps}fps • {formatBitrate(stats.bitrate)}</Text>
            </View>
          )}
          
          {/* Paused overlay */}
          {isPaused && (
            <View style={styles.pausedOverlay}>
              <Ionicons name="pause-circle" size={64} color="rgba(255,255,255,0.8)" />
              <Text style={styles.pausedText}>Paused</Text>
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.previewContainer, styles.placeholder]}>
          <Ionicons 
            name={isStreaming ? "videocam" : "videocam-off"} 
            size={48} 
            color={COLORS.textMuted} 
          />
          <Text style={styles.placeholderText}>
            {!isConnected ? 'Connect to gateway first' : 'Tap Start to begin streaming'}
          </Text>
        </View>
      )}

      {/* Controls */}
      {compact ? (
        <CompactControls
          isStreaming={isStreaming}
          isPaused={isPaused}
          isConnected={isConnected}
          onStart={() => startStream()}
          onStop={stopStream}
          onPause={pauseStream}
          onResume={resumeStream}
          onToggleCamera={toggleCamera}
        />
      ) : (
        <FullControls
          isStreaming={isStreaming}
          isPaused={isPaused}
          isConnected={isConnected}
          config={config}
          stats={stats}
          error={error}
          onStart={() => startStream()}
          onStop={stopStream}
          onPause={pauseStream}
          onResume={resumeStream}
          onToggleCamera={toggleCamera}
          onConfigChange={updateConfig}
        />
      )}
    </View>
  );
}

// Compact controls for embedded use
function CompactControls({
  isStreaming, isPaused, isConnected,
  onStart, onStop, onPause, onResume, onToggleCamera,
}) {
  return (
    <View style={styles.compactControls}>
      {/* Main button */}
      <TouchableOpacity
        style={[styles.mainButton, isStreaming && styles.mainButtonStop]}
        onPress={isStreaming ? onStop : onStart}
        disabled={!isConnected}
      >
        <Ionicons
          name={isStreaming ? "stop" : "videocam"}
          size={24}
          color={isStreaming ? "#fff" : COLORS.background}
        />
      </TouchableOpacity>

      {/* Pause/Resume */}
      {isStreaming && (
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={isPaused ? onResume : onPause}
        >
          <Ionicons
            name={isPaused ? "play" : "pause"}
            size={20}
            color={COLORS.primary}
          />
        </TouchableOpacity>
      )}

      {/* Camera toggle */}
      {isStreaming && (
        <TouchableOpacity style={styles.secondaryButton} onPress={onToggleCamera}>
          <Ionicons name="camera-reverse" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// Full controls with stats and settings
function FullControls({
  isStreaming, isPaused, isConnected, config, stats, error,
  onStart, onStop, onPause, onResume, onToggleCamera, onConfigChange,
}) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <View style={styles.fullControls}>
      {/* Status Bar */}
      <View style={styles.statusBar}>
        <View style={styles.statusLeft}>
          <Ionicons
            name={isStreaming ? "radio-button-on" : "radio-button-off"}
            size={16}
            color={isStreaming ? (isPaused ? "#FFC107" : "#4CAF50") : COLORS.textMuted}
          />
          <Text style={styles.statusText}>
            {!isConnected ? 'Disconnected' :
             isStreaming ? (isPaused ? 'Paused' : `Streaming ${stats.fps}fps`) :
             'Ready'}
          </Text>
        </View>
        
        {isStreaming && (
          <Text style={styles.bitrateText}>{formatBitrate(stats.bitrate)}</Text>
        )}
      </View>

      {/* Error message */}
      {error && (
        <View style={styles.errorBar}>
          <Ionicons name="alert-circle" size={14} color="#F44336" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Control Buttons */}
      <View style={styles.controlRow}>
        {/* Main button */}
        <TouchableOpacity
          style={[
            styles.controlButton,
            styles.mainControlButton,
            isStreaming && styles.stopButton,
            !isConnected && styles.disabledButton,
          ]}
          onPress={isStreaming ? onStop : onStart}
          disabled={!isConnected}
        >
          <Ionicons
            name={isStreaming ? "stop" : "videocam"}
            size={22}
            color={isStreaming ? "#fff" : COLORS.background}
          />
          <Text style={[styles.buttonText, isStreaming && styles.stopButtonText]}>
            {isStreaming ? 'Stop' : 'Start Stream'}
          </Text>
        </TouchableOpacity>

        {/* Pause/Resume */}
        {isStreaming && (
          <TouchableOpacity
            style={styles.controlButton}
            onPress={isPaused ? onResume : onPause}
          >
            <Ionicons
              name={isPaused ? "play" : "pause"}
              size={20}
              color={COLORS.primary}
            />
          </TouchableOpacity>
        )}

        {/* Camera toggle */}
        {isStreaming && (
          <TouchableOpacity style={styles.controlButton} onPress={onToggleCamera}>
            <Ionicons name="camera-reverse" size={20} color={COLORS.primary} />
          </TouchableOpacity>
        )}

        {/* Settings */}
        <TouchableOpacity
          style={styles.controlButton}
          onPress={() => setShowSettings(!showSettings)}
        >
          <Ionicons name="settings" size={20} color={COLORS.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Settings Panel */}
      {showSettings && (
        <View style={styles.settingsPanel}>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>FPS: {config.fps}</Text>
            <View style={styles.settingButtons}>
              {[5, 10, 15, 24].map(fps => (
                <TouchableOpacity
                  key={fps}
                  style={[styles.settingChip, config.fps === fps && styles.settingChipActive]}
                  onPress={() => onConfigChange({ fps })}
                >
                  <Text style={[styles.settingChipText, config.fps === fps && styles.settingChipTextActive]}>
                    {fps}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Quality: {Math.round(config.quality * 100)}%</Text>
            <View style={styles.settingButtons}>
              {[0.4, 0.6, 0.8].map(q => (
                <TouchableOpacity
                  key={q}
                  style={[styles.settingChip, config.quality === q && styles.settingChipActive]}
                  onPress={() => onConfigChange({ quality: q })}
                >
                  <Text style={[styles.settingChipText, config.quality === q && styles.settingChipTextActive]}>
                    {q === 0.4 ? 'Low' : q === 0.6 ? 'Med' : 'High'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function formatBitrate(kbps) {
  if (!kbps) return '0 kbps';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centerContent: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },

  // Permission
  permissionText: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: COLORS.primary,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: COLORS.background,
    fontWeight: '600',
  },

  // Preview
  previewContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    margin: 16,
  },
  camera: {
    flex: 1,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,15,15,0.9)',
  },
  placeholderText: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 12,
  },

  // Streaming indicator
  streamingIndicator: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  recordDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F44336',
  },
  streamingText: {
    color: '#F44336',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1,
  },
  statsText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
  },

  // Paused overlay
  pausedOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  pausedText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 8,
  },

  // Compact controls
  compactControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    gap: 12,
  },
  mainButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainButtonStop: {
    backgroundColor: '#F44336',
  },
  secondaryButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Full controls
  fullControls: {
    padding: 16,
    backgroundColor: 'rgba(15,15,15,0.9)',
    borderTopWidth: 1,
    borderTopColor: COLORS.primaryLight,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '500',
  },
  bitrateText: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    backgroundColor: 'rgba(244,67,54,0.15)',
    borderRadius: 6,
    marginBottom: 12,
  },
  errorText: {
    color: '#F44336',
    fontSize: 12,
    flex: 1,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  controlButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.cardBorder,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainControlButton: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  stopButton: {
    backgroundColor: '#F44336',
    borderColor: '#F44336',
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonText: {
    color: COLORS.background,
    fontWeight: '600',
    fontSize: 13,
  },
  stopButtonText: {
    color: '#fff',
  },

  // Settings
  settingsPanel: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  settingRow: {
    marginBottom: 12,
  },
  settingLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginBottom: 8,
  },
  settingButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  settingChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  settingChipActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primaryLight,
  },
  settingChipText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  settingChipTextActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
});

export default VideoStreamView;
