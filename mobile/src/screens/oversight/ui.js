/**
 * Small shared building blocks for the native Reviews page. Everything is
 * themed through useUIKit() — no hex literals.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Image, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Modal, Button } from '../../ui-kit';
import { getGatewayUrl, getGatewayAuthHeaders } from '../../utils/storage';
import { gatewayHttpOrigin } from '../../utils/gatewayHost';

/** Resolve a kit tone name to a live theme color. */
export function useTone() {
  const { colors } = useUIKit();
  return (tone) => toneColor(tone, colors);
}

/** Gateway HTTP origin + auth headers (for /api/verification/file images). */
export function useGatewayHttp() {
  const [cfg, setCfg] = useState({ origin: '', headers: {} });
  useEffect(() => {
    let alive = true;
    (async () => {
      const [url, headers] = await Promise.all([getGatewayUrl(), getGatewayAuthHeaders()]);
      if (alive) setCfg({ origin: gatewayHttpOrigin(url), headers: headers || {} });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return cfg;
}

/**
 * Image from an authenticated gateway route. Native passes the auth headers on
 * the image source; react-native-web ignores source headers, so on web the
 * bytes are fetched with the headers and shown from an object URL.
 */
export function AuthImage({ uri, headers, style, resizeMode = 'cover', accessibilityLabel }) {
  const [webUri, setWebUri] = useState(null);
  const [failed, setFailed] = useState(false);
  const isWeb = Platform.OS === 'web';
  useEffect(() => {
    if (!isWeb || !uri) return undefined;
    let alive = true;
    let objectUrl = null;
    setFailed(false);
    fetch(uri, { headers: headers || {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setWebUri(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isWeb, uri, headers]);
  if (!uri || failed) return <BrokenImage style={style} />;
  if (isWeb) return webUri ? <Image source={{ uri: webUri }} style={style} resizeMode={resizeMode} accessibilityLabel={accessibilityLabel} /> : null;
  return (
    <Image
      source={{ uri, headers }}
      style={style}
      resizeMode={resizeMode}
      onError={() => setFailed(true)}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

function BrokenImage({ style }) {
  const { colors } = useUIKit();
  return (
    <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>
      <Ionicons name="image-outline" size={20} color={colors.textTertiary} />
    </View>
  );
}

/** All-caps section label + body, the web's .ov-section / .arr-section. */
export function Section({ title, icon, tone, right, children, style }) {
  const { colors, type } = useUIKit();
  const c = tone ? toneColor(tone, colors) : colors.textMuted;
  return (
    <View style={[styles.section, style]}>
      <View style={styles.sectionHead}>
        {icon ? <Ionicons name={icon} size={14} color={c} style={{ marginRight: SPACE.xs }} /> : null}
        <Text style={[type.label, { color: tone ? c : colors.textMuted, flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        {right}
      </View>
      {children}
    </View>
  );
}

/** Key/value row (Run details grid). */
export function KV({ k, v, mono = false }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.kv, { borderBottomColor: colors.borderSubtle }]}>
      <Text style={[type.caption, { color: colors.textMuted, width: 96 }]}>{k}</Text>
      <Text style={[mono ? type.monoSmall : type.small, { color: colors.text, flex: 1 }]} selectable>
        {v}
      </Text>
    </View>
  );
}

/** Tone-tinted callout row (blockers, exit reason, issues). */
export function Callout({ tone = 'danger', label, children }) {
  const { colors, type, alpha } = useUIKit();
  const c = toneColor(tone, colors);
  return (
    <View
      style={[
        styles.callout,
        { borderColor: alpha(c, 0.35), borderLeftColor: c, backgroundColor: alpha(colors.text, 0.04) },
      ]}
    >
      {label ? <Text style={[type.label, { color: c, marginBottom: 2 }]}>{label}</Text> : null}
      <Text style={[type.small, { color: colors.text }]} selectable>
        {children}
      </Text>
    </View>
  );
}

/** Thin confidence bar + label. */
export function ConfidenceBar({ value }) {
  const { colors, type, alpha } = useUIKit();
  const pct = Math.round((value || 0) * 100);
  const c = toneColor(value >= 0.8 ? 'success' : value >= 0.5 ? 'warning' : 'danger', colors);
  return (
    <View style={styles.confRow} accessibilityLabel={`Confidence ${pct} percent`}>
      <View style={[styles.confTrack, { backgroundColor: alpha(colors.text, 0.1) }]}>
        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: c, borderRadius: 3 }} />
      </View>
      <Text style={[type.monoSmall, { color: c }]}>{pct}% conf.</Text>
    </View>
  );
}

/** A labelled toggle row (checkbox-like) at 44px. */
export function ToggleRow({ label, value, onChange, icon = 'alert-circle-outline' }) {
  const { colors, type, alpha } = useUIKit();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !!value }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.toggle,
        {
          borderColor: value ? colors.primary : colors.border,
          backgroundColor: value ? alpha(colors.primary, 0.1) : 'transparent',
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Ionicons name={value ? 'checkbox' : 'square-outline'} size={18} color={value ? colors.primary : colors.textMuted} />
      <Ionicons name={icon} size={14} color={colors.textMuted} />
      <Text style={[type.smallStrong, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Confirmation dialog (Alert.alert is a no-op on web). */
export function ConfirmModal({ visible, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }) {
  const { colors, type } = useUIKit();
  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={title}
      footer={
        <View style={styles.modalFooter}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title={confirmLabel} variant={danger ? 'danger' : 'primary'} onPress={onConfirm} />
        </View>
      }
    >
      <Text style={[type.small, { color: colors.textSecondary }]}>{message}</Text>
    </Modal>
  );
}

export const styles = StyleSheet.create({
  section: { marginTop: SPACE.lg },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACE.sm, minHeight: 20 },
  kv: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: SPACE.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth, gap: SPACE.sm },
  callout: { borderWidth: 1, borderLeftWidth: 3, borderRadius: RADIUS.sm, padding: SPACE.sm + 2, marginBottom: SPACE.xs + 2 },
  confRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  confTrack: { width: 64, height: 6, borderRadius: 3, overflow: 'hidden' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
});
