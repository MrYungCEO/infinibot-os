/**
 * Small shared building blocks for the Goals & Phases screen tabs: section
 * cards, collapsible blocks, monospaced output, select / toggle / number
 * fields, inline messages, confirm + persisted drafts. Kit tokens only.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Switch, Platform, Alert, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useUIKit, SPACE, RADIUS, HIT, MONO_FAMILY, Card, BottomSheet, EmptyState, toneColor, a11yPress } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { clampInt, isUnknownMethod, errMessage } from './goals-model';

export function Section({ title, right, children, style, tint = 'neutral', padded = true }) {
  const { colors, type } = useUIKit();
  return (
    <Card tint={tint} padded={padded ? SPACE.md : false} style={[{ marginBottom: SPACE.md }, style]}>
      {title || right ? (
        <View style={st.secHead}>
          {title ? <Text style={[type.label, { color: colors.primary, flex: 1 }]}>{title}</Text> : <View style={{ flex: 1 }} />}
          {right}
        </View>
      ) : null}
      {children}
    </Card>
  );
}

export function Collapsible({ title, meta, defaultOpen = false, open: openProp, onToggle, children, mono = false }) {
  const { colors, type } = useUIKit();
  const [openState, setOpen] = useState(defaultOpen);
  const open = openProp !== undefined ? openProp : openState;
  const toggle = () => (onToggle ? onToggle(!open) : setOpen(!open));
  return (
    <View style={st.collapse}>
      <Pressable
        onPress={toggle}
        style={({ pressed }) => [st.collapseHead, { opacity: pressed ? 0.75 : 1 }]}
        {...a11yPress({ label: `${open ? 'Collapse' : 'Expand'} ${typeof title === 'string' ? title : 'section'}`, expanded: open })}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={15} color={colors.textMuted} />
        {typeof title === 'string' ? (
          <Text style={[mono ? type.monoSmall : type.smallStrong, { color: colors.textSecondary, flex: 1 }]} numberOfLines={2}>
            {title}
          </Text>
        ) : (
          <View style={{ flex: 1 }}>{title}</View>
        )}
        {meta ? <Text style={[type.caption, { color: colors.textMuted }]}>{meta}</Text> : null}
      </Pressable>
      {open ? <View style={{ paddingTop: SPACE.xs }}>{children}</View> : null}
    </View>
  );
}

export function Pre({ children, maxHeight, tone }) {
  const { colors, type } = useUIKit();
  const c = tone ? toneColor(tone, colors) : colors.textSecondary;
  return (
    <View
      style={[
        st.pre,
        { backgroundColor: withAlpha('#000000', 0.35), borderColor: tone ? withAlpha(c, 0.35) : colors.borderSubtle },
        maxHeight ? { maxHeight, overflow: 'hidden' } : null,
      ]}
    >
      <Text selectable style={[type.monoSmall, { color: c }]}>
        {children}
      </Text>
    </View>
  );
}

export function Msg({ tone = 'danger', children, onPress }) {
  const { colors, type } = useUIKit();
  if (!children) return null;
  const c = toneColor(tone, colors);
  const body = (
    <View style={[st.msg, { borderColor: withAlpha(c, 0.45), backgroundColor: withAlpha(colors.text || '#fff', 0.05) }]}>
      <Ionicons
        name={tone === 'success' ? 'checkmark-circle-outline' : tone === 'warning' ? 'warning-outline' : tone === 'info' ? 'information-circle-outline' : 'alert-circle-outline'}
        size={16}
        color={c}
      />
      <Text style={[type.small, { color: c, flex: 1 }]} accessibilityRole={tone === 'danger' ? 'alert' : 'text'}>
        {children}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} {...a11yPress({ label: 'Dismiss message' })}>
      {body}
    </Pressable>
  ) : body;
}

export function Label({ children, required }) {
  const { colors, type } = useUIKit();
  return (
    <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.xs }]}>
      {children}
      {required ? <Text style={{ color: colors.primary }}> *</Text> : null}
    </Text>
  );
}

/** Plain styled TextInput for dense form rows (Field is too tall for grids). */
export function TextBox({ value, onChangeText, placeholder, mono, multiline, rows = 3, style, label, ...rest }) {
  const { colors, type } = useUIKit();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={withAlpha(colors.text || '#fff', 0.35)}
      multiline={multiline}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      autoCapitalize="none"
      autoCorrect={!mono}
      accessibilityLabel={label || placeholder}
      style={[
        mono ? type.mono : type.small,
        st.input,
        {
          color: colors.text,
          backgroundColor: colors.inputBg || withAlpha(colors.text || '#fff', 0.05),
          borderColor: focused ? withAlpha(colors.primary, 0.6) : colors.borderSubtle,
        },
        multiline ? { minHeight: 22 * rows, textAlignVertical: 'top', paddingTop: SPACE.sm } : null,
        style,
      ]}
      {...rest}
    />
  );
}

/** Integer input clamped to [min,max] on blur, like the web numField(). */
export function NumBox({ label, value, min, max, onChange, style }) {
  const { colors, type } = useUIKit();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = clampInt(text, min, max, value);
    setText(String(n));
    if (n !== value) onChange(n);
  };
  return (
    <View style={[{ flex: 1, minWidth: 130 }, style]}>
      <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>{label}</Text>
      <TextBox value={text} onChangeText={setText} onBlur={commit} onEndEditing={commit} keyboardType="numbers-and-punctuation" mono label={label} />
    </View>
  );
}

/**
 * Select — a pressable field that opens a BottomSheet of options.
 * options: [{ value, label, hint?, group? }]
 */
export function Select({ label, value, options, onChange, placeholder = 'Select…', style, compact }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  let lastGroup = null;
  return (
    <View style={[{ flex: 1, minWidth: compact ? 110 : 140 }, style]}>
      {label ? <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>{label}</Text> : null}
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          st.input,
          st.select,
          { backgroundColor: colors.inputBg || withAlpha(colors.text || '#fff', 0.05), borderColor: colors.borderSubtle, opacity: pressed ? 0.75 : 1 },
        ]}
        {...a11yPress({ label: `${label || 'Select'}: ${cur ? cur.label : placeholder}` })}
      >
        <Text style={[type.small, { color: cur ? colors.text : colors.textMuted, flex: 1 }]} numberOfLines={1}>
          {cur ? cur.label : placeholder}
        </Text>
        <Ionicons name="chevron-down" size={15} color={colors.textMuted} />
      </Pressable>
      <BottomSheet visible={open} onClose={() => setOpen(false)} title={label || 'Select'}>
        {options.map((o) => {
          const head = o.group && o.group !== lastGroup ? o.group : null;
          lastGroup = o.group || lastGroup;
          const on = o.value === value;
          return (
            <View key={`${o.group || ''}:${o.value}`}>
              {head ? <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.md, marginBottom: SPACE.xs }]}>{head}</Text> : null}
              <Pressable
                onPress={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                style={({ pressed }) => [
                  st.option,
                  {
                    borderColor: on ? withAlpha(colors.primary, 0.5) : colors.borderSubtle,
                    backgroundColor: on ? withAlpha(colors.primary, 0.1) : 'transparent',
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
                {...a11yPress({ label: o.label, selected: on })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: on ? colors.primary : colors.text }]}>{o.label}</Text>
                  {o.hint ? <Text style={[type.caption, { color: colors.textMuted }]}>{o.hint}</Text> : null}
                </View>
                {on ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
              </Pressable>
            </View>
          );
        })}
      </BottomSheet>
    </View>
  );
}

export function ToggleRow({ label, value, onChange, hint }) {
  const { colors, type } = useUIKit();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={({ pressed }) => [st.toggle, { opacity: pressed ? 0.8 : 1 }]}
      {...a11yPress({ label, role: 'switch', checked: value })}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.small, { color: colors.text }]}>{label}</Text>
        {hint ? <Text style={[type.caption, { color: colors.textMuted }]}>{hint}</Text> : null}
      </View>
      <Switch
        value={Boolean(value)}
        onValueChange={onChange}
        trackColor={{ false: withAlpha(colors.text || '#fff', 0.15), true: withAlpha(colors.primary, 0.55) }}
        thumbColor={value ? colors.primary : colors.textMuted}
        accessibilityLabel={label}
      />
    </Pressable>
  );
}

export function Dot({ tone, size = 8 }) {
  const { colors } = useUIKit();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor(tone, colors) }} />;
}

export function MetaLine({ items, mono }) {
  const { colors, type } = useUIKit();
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <Text style={[mono ? type.monoSmall : type.caption, { color: colors.textMuted }]}>
      {list.join('  ·  ')}
    </Text>
  );
}

/** Empty / error / not-served states. */
export function LoadState({ error, onRetry, unavailableTitle, unavailableMessage }) {
  if (!error) return null;
  if (isUnknownMethod(error)) {
    return (
      <EmptyState
        icon="cloud-offline-outline"
        title={unavailableTitle || 'Not available on this gateway'}
        message={unavailableMessage || 'This gateway build does not serve these RPCs yet. Update or restart the gateway, then pull to refresh.'}
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
      />
    );
  }
  return (
    <EmptyState
      icon="alert-circle-outline"
      tone="danger"
      title="Could not load"
      message={errMessage(error)}
      actionLabel={onRetry ? 'Retry' : undefined}
      onAction={onRetry}
    />
  );
}

/** Cross-platform confirm (RN-web's Alert has no buttons). */
export function confirmAsync(title, message, okLabel = 'OK', destructive = true) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message ? `${title}\n\n${message}` : title) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Draft state persisted to AsyncStorage (the web keeps it in localStorage). */
export function usePersistentDraft(key, merge) {
  const [draft, setDraftState] = useState(() => merge(null));
  const loaded = useRef(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (!alive || !raw) return;
        try { setDraftState(merge(JSON.parse(raw))); } catch { /* ignore */ }
      })
      .catch(() => {})
      .finally(() => { loaded.current = true; });
    return () => { alive = false; };
  }, [key, merge]);
  const setDraft = useCallback((patch) => {
    setDraftState((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
      AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [key]);
  return [draft, setDraft];
}

/** Auto-clearing notice text. */
export function useFlash(ms = 3000) {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);
  const flash = useCallback((msg) => {
    setNotice(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), ms);
  }, [ms]);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);
  return [notice, flash, setNotice];
}

/** Subscribe to several gateway events; handler is debounced 300ms (web parity). */
export function useGatewayEvents(gateway, names, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = names.join('|');
  useEffect(() => {
    if (typeof gateway?.subscribeEvent !== 'function') return undefined;
    let t = null;
    const fire = () => {
      if (t) return;
      t = setTimeout(() => { t = null; ref.current?.(); }, 300);
    };
    const offs = key.split('|').map((n) => gateway.subscribeEvent(n, fire));
    return () => {
      offs.forEach((o) => o?.());
      if (t) clearTimeout(t);
    };
  }, [gateway?.subscribeEvent, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => ref.current?.(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Agent pickers: coding CLIs + gateway agents, grouped like the web optgroups. */
export function targetOptions(agents, { prefix = true, includeNone = false, cli } = {}) {
  const cliList = cli || [];
  const out = [];
  if (includeNone) out.push({ value: '', label: 'None' });
  for (const o of cliList) out.push({ value: prefix ? `cli:${o.id}` : o.id, label: o.label, group: 'Coding CLIs' });
  for (const a of agents || []) {
    out.push({
      value: prefix ? `agent:${a.id}` : a.id,
      label: `${a.name}${a.name !== a.id ? ` (${a.id})` : ''}`,
      group: 'Gateway agents',
    });
  }
  return out;
}

export const st = StyleSheet.create({
  secHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm, minHeight: 24 },
  collapse: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.08)', paddingVertical: SPACE.xs },
  collapseHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: HIT.min },
  pre: { borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, marginTop: SPACE.xs },
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, marginVertical: SPACE.xs },
  input: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, minHeight: HIT.min, paddingVertical: 8 },
  select: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  option: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: HIT.min + 4, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, marginBottom: SPACE.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: HIT.min, paddingVertical: SPACE.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  mono: { fontFamily: MONO_FAMILY },
});
