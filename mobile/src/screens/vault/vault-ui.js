/**
 * vault-ui — small shared pieces for the native Kingly Vault screen:
 * avatar, key/value rows, option-chip pickers, a stat grid, and the
 * confirm / prompt dialogs (window.prompt/confirm on the web page).
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useUIKit,
  SPACE,
  RADIUS,
  MONO_FAMILY,
  Chip,
  Button,
  Field,
  Modal,
  StatCard,
  EmptyState,
} from '../../ui-kit';
import { initials, isMissingMethod, isNotConfigured, errorText } from './vault-model';

export function Avatar({ uri, name, size = 40, online }) {
  const { colors, type, alpha } = useUIKit();
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={box}>
      {uri && !failed ? (
        <Image source={{ uri }} style={[box, { borderWidth: 1, borderColor: colors.border }]} onError={() => setFailed(true)} />
      ) : (
        <View style={[box, styles.center, { backgroundColor: alpha(colors.primary, 0.12), borderWidth: 1, borderColor: colors.border }]}>
          <Text style={[type.smallStrong, { color: colors.primary, fontSize: Math.max(12, Math.round(size * 0.34)) }]}>{initials(name)}</Text>
        </View>
      )}
      {online !== undefined ? (
        <View
          style={[styles.dot, { backgroundColor: online ? colors.success : colors.textMuted, borderColor: colors.background || '#000' }]}
          accessibilityLabel={online ? 'Online' : 'Offline'}
        />
      ) : null}
    </View>
  );
}

export function KV({ label, value, mono = true }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.kv}>
      <Text style={[type.caption, { color: colors.textMuted }]}>{label}</Text>
      <Text
        style={[mono ? type.monoSmall : type.small, { color: colors.text, flexShrink: 1, textAlign: 'right' }, mono && { fontFamily: MONO_FAMILY }]}
        numberOfLines={2}
        selectable
      >
        {value === undefined || value === null || value === '' ? '-' : String(value)}
      </Text>
    </View>
  );
}

/** A wrapping row of option chips — the phone's stand-in for a <select>. */
export function OptionChips({ label, options, value, onChange, allowNone = false, noneLabel = 'All', multi = false }) {
  const { colors, type } = useUIKit();
  const items = (options || []).map((o) => (typeof o === 'object' ? o : { key: o, label: String(o) }));
  const isOn = (k) => (multi ? (value || []).includes(k) : value === k);
  return (
    <View style={{ gap: SPACE.xs }}>
      {label ? <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text> : null}
      <View style={styles.wrap}>
        {allowNone ? (
          <Chip label={noneLabel} selected={value === null || value === undefined || value === ''} tone="primary" onPress={() => onChange(null)} accessibilityLabel={`${label || 'Filter'}: ${noneLabel}`} />
        ) : null}
        {items.map((o) => (
          <Chip
            key={String(o.key)}
            label={o.label}
            icon={o.icon}
            tone={o.tone || 'primary'}
            selected={isOn(o.key)}
            onPress={() => onChange(o.key)}
            accessibilityLabel={`${label || 'Option'}: ${o.label}`}
          />
        ))}
      </View>
    </View>
  );
}

/** Responsive grid of StatCards: 2 columns on a phone, 3 in landscape / tablets. */
export function StatGrid({ items, onPressItem }) {
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 3 : 2;
  const basis = `${Math.floor(100 / cols) - 2}%`;
  return (
    <View style={styles.grid}>
      {(items || []).map((it) => (
        <View key={it.key || it.label} style={{ width: basis, flexGrow: 1 }}>
          <StatCard
            compact
            label={it.label}
            value={it.value}
            icon={it.icon}
            tone={it.tone}
            delta={it.delta}
            deltaLabel={it.deltaLabel}
            footnote={it.footnote}
            onPress={onPressItem && it.section ? () => onPressItem(it) : undefined}
            accessibilityLabel={onPressItem && it.section ? `${it.label}: ${it.value}. Open ${it.section}` : undefined}
          />
        </View>
      ))}
    </View>
  );
}

/** Error / missing-method / not-configured state for one section. */
export function SectionError({ error, onRetry, what = 'this section' }) {
  if (!error) return null;
  if (isMissingMethod(error)) {
    return (
      <EmptyState
        icon="cloud-offline-outline"
        title="Not available on this gateway"
        message={`This gateway does not serve ${what} yet (${errorText(error)}). Update or restart the gateway to enable it.`}
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
        compact
      />
    );
  }
  if (isNotConfigured(error)) {
    return (
      <EmptyState
        icon="logo-discord"
        title="Discord not connected"
        message={`${errorText(error)}. Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID on the gateway, then retry.`}
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
        compact
      />
    );
  }
  return (
    <EmptyState
      icon="alert-circle-outline"
      tone="danger"
      title="Could not load"
      message={errorText(error)}
      actionLabel={onRetry ? 'Retry' : undefined}
      onAction={onRetry}
      compact
    />
  );
}

export function Banner({ tone = 'success', text, onClose }) {
  const { colors, type } = useUIKit();
  if (!text) return null;
  const c = tone === 'danger' ? colors.error : tone === 'warning' ? colors.warning : colors.success;
  return (
    <View style={[styles.banner, { borderColor: c, backgroundColor: colors.surface }]} accessibilityLiveRegion="polite">
      <Ionicons name={tone === 'danger' ? 'alert-circle' : 'checkmark-circle'} size={16} color={c} />
      <Text style={[type.small, { color: colors.text, flex: 1 }]}>{text}</Text>
      {onClose ? (
        <Ionicons name="close" size={18} color={colors.textMuted} onPress={onClose} accessibilityLabel="Dismiss" accessibilityRole="button" style={{ padding: SPACE.sm }} />
      ) : null}
    </View>
  );
}

/**
 * useDialogs — promise-returning confirm() and prompt() rendered with the kit
 * Modal (Alert.alert has no buttons on Expo web, and prompt doesn't exist on iOS).
 */
export function useDialogs() {
  const [dlg, setDlg] = useState(null);
  const [text, setText] = useState('');
  const resolver = useRef(null);

  const close = useCallback((result) => {
    const r = resolver.current;
    resolver.current = null;
    setDlg(null);
    r?.(result);
  }, []);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setDlg({ kind: 'confirm', ...opts });
  }), []);

  const prompt = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setText(opts?.initial || '');
    setDlg({ kind: 'prompt', ...opts });
  }), []);

  const element = dlg ? (
    <Modal
      visible
      onClose={() => close(dlg.kind === 'prompt' ? null : false)}
      title={dlg.title}
      subtitle={dlg.message}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" size="sm" onPress={() => close(dlg.kind === 'prompt' ? null : false)} />
          <Button
            title={dlg.confirmLabel || (dlg.kind === 'prompt' ? 'OK' : 'Confirm')}
            variant={dlg.danger ? 'danger' : 'primary'}
            size="sm"
            disabled={dlg.kind === 'prompt' && dlg.required && !text.trim()}
            onPress={() => close(dlg.kind === 'prompt' ? text : true)}
          />
        </View>
      }
    >
      {dlg.kind === 'prompt' ? (
        <Field
          value={text}
          onChangeText={setText}
          placeholder={dlg.placeholder}
          multiline={Boolean(dlg.multiline)}
          rows={3}
          autoFocus
          accessibilityLabel={dlg.title}
        />
      ) : null}
    </Modal>
  ) : null;

  return { confirm, prompt, element };
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.xs, minHeight: 28 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  banner: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, marginTop: SPACE.sm },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
});
