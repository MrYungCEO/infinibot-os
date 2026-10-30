/**
 * Learn — small shared pieces: progress ring, plugin monogram, markdown body,
 * certificate viewer (react-native-svg SvgXml) + share/download.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Platform, Share, useWindowDimensions } from 'react-native';
import Svg, { Circle, Text as SvgText, SvgXml } from 'react-native-svg';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, BottomSheet, Button, EmptyState } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { monogramText, pluginAccent, prepareCertSvg, certFileName, TIER_TITLE } from './learn-model';

let Sharing = null;
try {
  // eslint-disable-next-line global-require
  Sharing = require('expo-sharing');
} catch {
  Sharing = null;
}
let FS = null;
try {
  // eslint-disable-next-line global-require
  FS = require('expo-file-system');
} catch {
  FS = null;
}

/** Circular percent ring (the web's .lv2-ring). */
export function Ring({ percent = 0, size = 40, accent }) {
  const { colors, type } = useUIKit();
  const r = 16;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const stroke = accent || colors.primary;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={`${p}% complete`} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Circle cx="20" cy="20" r={r} fill="none" stroke={withAlpha(colors.text, 0.12)} strokeWidth={3.5} />
        {p > 0 ? (
          <Circle
            cx="20"
            cy="20"
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeDasharray={`${(p / 100) * c} ${c}`}
            transform="rotate(-90 20 20)"
          />
        ) : null}
        <SvgText x="20" y="24" textAnchor="middle" fontSize="11" fontWeight="700" fill={colors.text} fontFamily={type.monoSmall.fontFamily}>
          {String(p)}
        </SvgText>
      </Svg>
    </View>
  );
}

/** Plugin monogram tile, or a core-track glyph. */
export function Monogram({ plugin, pluginId, size = 36, icon = 'school-outline' }) {
  const { colors, type } = useUIKit();
  const accent = pluginAccent(plugin) || colors.primary;
  const text = pluginId ? monogramText(plugin, pluginId) : null;
  return (
    <View
      style={[
        styles.mono,
        {
          width: size,
          height: size,
          borderRadius: size > 44 ? RADIUS.lg : RADIUS.md,
          borderColor: withAlpha(accent, 0.45),
          backgroundColor: withAlpha(accent, 0.12),
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {text ? (
        <Text style={[type.smallStrong, { color: accent, fontSize: size > 44 ? 17 : 13 }]}>{text}</Text>
      ) : (
        <Ionicons name={icon} size={size > 44 ? 26 : 18} color={accent} />
      )}
    </View>
  );
}

export function makeMarkdownStyles(colors, type) {
  return {
    body: { color: colors.textSecondary, fontFamily: type.body.fontFamily, fontSize: 14, lineHeight: 21 },
    paragraph: { marginTop: 0, marginBottom: SPACE.sm },
    strong: { fontFamily: type.bodyStrong.fontFamily, color: colors.text },
    em: { fontStyle: 'italic' },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    heading1: { color: colors.text, fontSize: 18, marginVertical: SPACE.xs },
    heading2: { color: colors.text, fontSize: 16, marginVertical: SPACE.xs },
    heading3: { color: colors.primary, fontSize: 14, marginVertical: SPACE.xs },
    bullet_list: { marginBottom: SPACE.sm },
    ordered_list: { marginBottom: SPACE.sm },
    list_item: { marginVertical: 2 },
    code_inline: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.08),
      color: colors.text,
      paddingHorizontal: 4,
      borderRadius: 4,
      borderWidth: 0,
      fontSize: 13,
    },
    fence: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.06),
      color: colors.text,
      padding: SPACE.md,
      borderRadius: RADIUS.sm,
      borderWidth: 0,
      fontSize: 12,
    },
    code_block: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.06),
      color: colors.text,
      padding: SPACE.md,
      borderRadius: RADIUS.sm,
      borderWidth: 0,
      fontSize: 12,
    },
    blockquote: {
      backgroundColor: withAlpha(colors.primary, 0.07),
      borderLeftColor: colors.primary,
      borderLeftWidth: 3,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.xs,
      marginVertical: SPACE.xs,
    },
  };
}

export function Md({ children }) {
  const { colors, type } = useUIKit();
  const md = useMemo(() => makeMarkdownStyles(colors, type), [colors, type]);
  if (!children) return null;
  return <Markdown style={md}>{String(children)}</Markdown>;
}

/** Status line used for transient success / error flashes. */
export function Flash({ text, tone = 'success' }) {
  const { colors, type } = useUIKit();
  if (!text) return null;
  const c = tone === 'danger' ? colors.error : colors.success;
  return (
    <View accessibilityLiveRegion="polite" style={[styles.flash, { borderColor: withAlpha(c, 0.5), backgroundColor: withAlpha(c, 0.08) }]}>
      <Ionicons name={tone === 'danger' ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={16} color={c} />
      <Text style={[type.small, { color: colors.text, flex: 1 }]}>{text}</Text>
    </View>
  );
}

async function shareSvg(svg, name) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  if (FS?.File && FS?.Paths && Sharing) {
    const file = new FS.File(FS.Paths.cache, name);
    try {
      if (file.exists) file.delete();
    } catch {
      /* stale */
    }
    file.create();
    file.writeSync(svg);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, { mimeType: 'image/svg+xml', UTI: 'public.svg-image', dialogTitle: name });
      return;
    }
  }
  await Share.share({ message: svg, title: name });
}

/**
 * Certificate viewer — renders the gateway's certificate SVG natively.
 * cert = { tier, svg, displayName? } | null.
 */
export function CertificateSheet({ cert, onClose }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const [err, setErr] = useState(null);
  const xml = useMemo(() => (cert ? prepareCertSvg(cert.svg) : null), [cert]);
  const w = Math.min(width - SPACE.lg * 2, 860);
  return (
    <BottomSheet
      visible={Boolean(cert)}
      onClose={onClose}
      title={cert ? `${TIER_TITLE[cert.tier] || cert.tier} certificate` : 'Certificate'}
      subtitle="InfiniBot AI Agent Systems certification"
      footer={
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          <Button title="Close" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
          <Button
            title={Platform.OS === 'web' ? 'Download SVG' : 'Share SVG'}
            icon="share-outline"
            variant="primary"
            style={{ flex: 1 }}
            disabled={!cert}
            onPress={async () => {
              try {
                setErr(null);
                await shareSvg(cert.svg, certFileName(cert.tier, cert.displayName));
              } catch (e) {
                setErr(e?.message || String(e));
              }
            }}
          />
        </View>
      }
    >
      {xml ? (
        <View style={{ width: w, aspectRatio: 1200 / 850, alignSelf: 'center', borderRadius: RADIUS.md, overflow: 'hidden' }}>
          <SvgXml xml={xml} width="100%" height="100%" />
        </View>
      ) : cert ? (
        <EmptyState compact tone="danger" icon="alert-circle-outline" title="Certificate could not be rendered" message="The gateway returned an empty certificate." />
      ) : null}
      {err ? <Text style={[type.small, { color: colors.error, marginTop: SPACE.sm }]}>{err}</Text> : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  mono: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  flash: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    marginBottom: SPACE.md,
  },
});
