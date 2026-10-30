/**
 * TerminalCallButton — header voice button on terminal-style screens
 * (TerminalsScreen, FederationTerminalScreen, ChatScreen via ChatHeader).
 *
 * Opens the InfiniBot call page (local voice by default; Cloud voice
 * (Robovoice) is an optional, free choice on that page) — the same
 * destination as the More/Launchpad "Voice" item.
 *
 * Hidden when there is no session id, matching where it used to appear.
 */

import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { openVoice } from '../navigation/screen-registry';

export function TerminalCallButton({ terminalSessionId, size = 17, style }) {
  const { colors } = useTheme();
  const navigation = useNavigation();

  if (!terminalSessionId) return null;

  return (
    <TouchableOpacity
      onPress={() => openVoice(navigation)}
      hitSlop={8}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Voice"
      accessibilityHint="Opens a voice call with InfiniBot"
      style={[styles.btn, style]}
    >
      <Ionicons name="mic-outline" size={size} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
