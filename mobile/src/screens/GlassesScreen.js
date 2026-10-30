/**
 * GlassesScreen — VisionClaw-style camera + InfiniBot agent.
 *
 * Type a question (or leave it empty for "What am I looking at?") and tap the
 * shutter:
 *   - A camera frame is captured
 *   - Prompt + frame ship to /v1/chat/completions as multimodal content
 *   - The reply lands in the on-screen transcript
 *
 * The mic button opens the InfiniBot call page (local voice by default;
 * Cloud voice (Robovoice) is optional).
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  Platform, ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, FONTS } from '../constants/theme';
import { getGatewayUrl, getAuthToken, getGatewayAuthHeaders } from '../utils/storage';
import { gatewayHttpOrigin } from '../utils/gatewayHost';
import { openVoice } from '../navigation/screen-registry';

const DEFAULT_PROMPT = 'What am I looking at?';


// Floating back button — Glasses is a full-screen camera modal with no nav
// header, so it must supply its own dismiss affordance on every state.
function GlassesBackButton({ navigation }) {
  const insets = useSafeAreaInsets();
  return (
    <TouchableOpacity
      onPress={() => navigation?.goBack?.()}
      style={[styles.backFab, { top: Math.max(insets.top, 12) + 4 }]}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel="Back"
    >
      <Ionicons name="chevron-back" size={24} color="#e4e4e7" />
    </TouchableOpacity>
  );
}

export function GlassesScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('back');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ask about what the camera sees.');
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState([]);  // {role, text}[]
  const [agentId] = useState('visionclaw');
  const [config, setConfig] = useState({ url: '', token: '' });
  const cameraRef = useRef(null);

  // Load gateway config on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [url, token] = await Promise.all([getGatewayUrl(), getAuthToken()]);
      if (!mounted) return;
      setConfig({ url: gatewayHttpOrigin(url), token: token || '' });
    })();
    return () => { mounted = false; };
  }, []);

  const snapFrame = useCallback(async () => {
    if (!cameraRef.current) return null;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.55,
        skipProcessing: true,
      });
      // Cap edge to ~640px to keep payload small (~80-150KB per frame).
      if (photo?.base64) return `data:image/jpeg;base64,${photo.base64}`;
    } catch (e) {
      console.log('snapFrame error:', e.message);
    }
    return null;
  }, []);

  const ask = useCallback(async () => {
    if (busy) return;
    const text = prompt.trim() || DEFAULT_PROMPT;
    setBusy(true);
    try {
      setStatus('Looking…');
      const frame = await snapFrame();
      setStatus('Thinking…');
      setTurns((prev) => [{ role: 'user', text }, ...prev]);
      setPrompt('');
      const reply = await chatCompletion(text, frame, config, agentId);
      setTurns((prev) => [{ role: 'ai', text: reply }, ...prev]);
      setStatus('Ask about what the camera sees.');
    } catch (e) {
      setStatus('Error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }, [busy, prompt, snapFrame, config, agentId]);

  if (!permission) {
    return <CenterText text="Loading camera…" />;
  }
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <GlassesBackButton navigation={navigation} />
        <Ionicons name="camera-outline" size={48} color={COLORS.textMuted} />
        <Text style={styles.hero}>Camera access needed</Text>
        <Text style={styles.sub}>Glasses needs your camera to send InfiniBot what you're looking at.</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Grant camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!config.token) {
    return (
      <View style={styles.center}>
        <GlassesBackButton navigation={navigation} />
        <Ionicons name="lock-closed-outline" size={48} color={COLORS.textMuted} />
        <Text style={styles.hero}>Sign in first</Text>
        <Text style={styles.sub}>Connect to your InfiniBot gateway from the Settings tab, then come back.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
      />
      <LinearGradient
        colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.85)']}
        locations={[0, 0.3, 0.7, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <GlassesBackButton navigation={navigation} />

      <View style={styles.statusBar}>
        <Text style={styles.status}>{status}</Text>
      </View>

      <ScrollView
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {turns.map((t, i) => (
          <View key={i} style={[styles.turn, t.role === 'user' ? styles.turnUser : styles.turnAi]}>
            <Text style={[styles.turnText, t.role === 'user' && styles.turnUserText]}>
              {t.text}
            </Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.promptRow}>
        <TextInput
          style={styles.promptInput}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={DEFAULT_PROMPT}
          placeholderTextColor="rgba(228,228,231,0.45)"
          editable={!busy}
          returnKeyType="send"
          onSubmitEditing={ask}
          accessibilityLabel="Question about the camera view"
        />
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
        >
          <Ionicons name="camera-reverse-outline" size={22} color="#e4e4e7" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.ptt, busy && styles.pttBusy]}
          onPress={ask}
          disabled={busy}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Capture and ask"
        >
          {busy
            ? <ActivityIndicator color="#0a0a0a" size="large" />
            : <Ionicons name="aperture" size={36} color="#0a0a0a" />}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => openVoice(navigation)}
          accessibilityRole="button"
          accessibilityLabel="Voice"
          accessibilityHint="Opens a voice call with InfiniBot"
        >
          <Ionicons name="mic-outline" size={22} color="#e4e4e7" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

async function chatCompletion(prompt, frame, config, agent) {
  const userContent = frame
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: frame } },
      ]
    : prompt;
  if (!config.url) throw new Error('Set your gateway URL in Settings first.');
  const res = await fetch(`${config.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await getGatewayAuthHeaders()),
    },
    body: JSON.stringify({
      model: agent,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chat failed (${res.status})${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? '(no response)';
}

function CenterText({ text }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={COLORS.primary} />
      <Text style={styles.sub}>{text}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 24, gap: 14, backgroundColor: '#050510',
  },
  hero: {
    fontSize: 22, fontFamily: FONTS?.display ?? 'System',
    color: '#e4e4e7', marginTop: 8,
  },
  sub: {
    fontSize: 14, color: '#a1a1aa', textAlign: 'center', maxWidth: 320, lineHeight: 20,
  },
  primaryBtn: {
    marginTop: 12,
    paddingVertical: 14, paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: COLORS?.primary ?? COLORS.primary,
  },
  primaryBtnText: { fontWeight: '700', color: '#0a0a0a', fontSize: 16 },
  backFab: {
    position: 'absolute',
    left: 14,
    zIndex: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(8,8,16,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBar: {
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingLeft: 66,
    paddingRight: 18,
    paddingBottom: 8,
  },
  status: {
    fontSize: 13, fontWeight: '700', color: COLORS.primary,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    letterSpacing: 0.4,
  },
  transcript: { flex: 1, paddingHorizontal: 16 },
  transcriptContent: {
    flexDirection: 'column-reverse',
    gap: 10,
    paddingBottom: 16,
  },
  turn: {
    padding: 12,
    borderRadius: 14,
    maxWidth: '88%',
  },
  turnUser: {
    backgroundColor: 'rgba(250,204,21,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(250,204,21,0.35)',
    alignSelf: 'flex-end',
  },
  turnAi: {
    backgroundColor: 'rgba(8,8,16,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignSelf: 'flex-start',
  },
  turnText: { color: '#e4e4e7', fontSize: 15, lineHeight: 20 },
  turnUserText: { color: '#fef3c7' },
  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  iconBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(8,8,16,0.7)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  ptt: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: COLORS.primary,
    borderWidth: 4, borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
  },
  pttBusy: {
    transform: [{ scale: 0.94 }],
    opacity: 0.8,
  },
  promptRow: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  promptInput: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: 'rgba(8,8,16,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    color: '#e4e4e7',
    fontSize: 15,
  },
});
