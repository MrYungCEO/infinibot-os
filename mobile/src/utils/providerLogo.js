import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

const INFINIBOT_PNG = require('../../assets/infinibot-logo.png');

export function detectProvider({ provider, model, coderBackend, cliBackend, backend } = {}) {
  const tokens = [provider, model, coderBackend, cliBackend, backend]
    .filter(Boolean)
    .map(v => String(v).toLowerCase());
  if (tokens.length === 0) return 'unknown';
  const joined = tokens.join(' ');

  if (/(claude|anthropic|claude-code)/.test(joined)) return 'claude';
  if (/opencode/.test(joined)) return 'opencode';
  if (/(openai|^codex|[^a-z]codex|^gpt-|[^a-z]gpt-|o1-|o3-|o4-)/.test(joined)) return 'openai';
  const isInfinibot =
    /(native|infinibot|infinibot-native|mcp)/.test(joined) ||
    backend === 'native' ||
    cliBackend === 'native';
  if (isInfinibot) return 'infinibot';
  return 'unknown';
}

/**
 * InfiniBot's neutral letter monogram in a rounded square (C / X / OC).
 * Deliberately not the providers' logos: third-party logos need the owner's
 * permission, so the provider is named in text (providerLabel) instead.
 * See docs/licensing/BRAND-USAGE.md.
 */
function MonogramSvg({ size, color, letters }) {
  const two = letters.length > 1;
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Rect
        x={0.5} y={0.5} width={15} height={15} rx={3.5}
        fill={color} fillOpacity={0.14} stroke={color} strokeWidth={1}
      />
      <SvgText
        x={8} y={two ? 11.2 : 11.6} textAnchor="middle"
        fontSize={two ? 8.4 : 10} fontWeight="800" fill={color}
      >
        {letters}
      </SvgText>
    </Svg>
  );
}

const MONOGRAM = { claude: 'C', openai: 'X', opencode: 'OC', gemini: 'G', grok: 'Gk' };

/**
 * Renders the glyph for a provider: a neutral letter monogram for coder CLIs
 * (tinted by `color`), the full-colour InfiniBot mark for native agents, and a
 * generic chip icon otherwise.
 */
export function ProviderLogo({ provider, size = 18, color = '#fff', style }) {
  if (MONOGRAM[provider]) {
    return (
      <View style={[styles.center, style]}>
        <MonogramSvg size={size} color={color} letters={MONOGRAM[provider]} />
      </View>
    );
  }
  if (provider === 'infinibot') {
    return (
      <View style={[styles.center, style]}>
        <Image
          source={INFINIBOT_PNG}
          style={{ width: size, height: size, resizeMode: 'contain' }}
        />
      </View>
    );
  }
  return (
    <View style={[styles.center, style]}>
      <Ionicons name="hardware-chip-outline" size={size} color={color} />
    </View>
  );
}

/** Plain-text provider name, shown next to / instead of the glyph. */
export function providerLabel(provider) {
  switch (provider) {
    case 'claude': return 'Claude';
    case 'openai': return 'OpenAI';
    case 'opencode': return 'OpenCode';
    case 'gemini': return 'Gemini';
    case 'grok': return 'Grok';
    case 'infinibot': return 'InfiniBot';
    default: return 'Agent';
  }
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default ProviderLogo;
