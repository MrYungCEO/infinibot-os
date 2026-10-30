/**
 * ChatComposer — the message box, styled like the web composer (`.wc-composer`):
 * a 24px-radius glass pill with a strong accent border on focus, a multi-line
 * input, an attach-image button and a round accent send button that turns into
 * a stop button while a reply is streaming.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from './chat-tokens';
import { useSecureAccent } from '../secure/SecureControls';
import { useImageAttach } from './useImageAttach';
import { success, tap } from '../utils/haptics';

export function ChatComposer({ onSend, onAbort, isStreaming, disabled, placeholder = 'Message InfiniBot', onHeightChange, draft, draftKey, secure = false, accessory = null }) {
  const t = useChatTokens();
  const secureColor = useSecureAccent();
  const [text, setText] = useState('');

  // A prefilled message handed over by another screen (e.g. the knowledge
  // graph's "Ask AI about this"): it lands in the box for review, never auto-sent.
  useEffect(() => {
    if (typeof draft === 'string' && draft) setText(draft);
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [image, setImage] = useState(null);
  const [focused, setFocused] = useState(false);

  const canSend = (text.trim().length > 0 || image) && !disabled && !isStreaming;

  const submit = useCallback(() => {
    if (!canSend) return;
    success();
    onSend(text, image);
    setText('');
    setImage(null);
  }, [canSend, onSend, text, image]);

  const { attach } = useImageAttach(setImage);

  return (
    <View
      onLayout={(e) => onHeightChange?.(e.nativeEvent.layout.height)}
      style={[
        styles.box,
        {
          borderRadius: t.radius.composer,
          borderColor: secure ? secureColor : focused ? t.accent : t.borderStrong,
          ...(secure ? { borderWidth: 2 } : null),
          backgroundColor: t.side,
          shadowColor: secure ? secureColor : focused ? t.accent : '#000',
        },
      ]}
    >
      {image ? (
        <View style={styles.atts}>
          <View>
            <Image source={{ uri: image.uri }} style={[styles.att, { borderColor: t.border }]} />
            <Pressable
              onPress={() => setImage(null)}
              hitSlop={10}
              style={[styles.attX, { backgroundColor: t.side, borderColor: t.borderStrong }]}
              accessibilityRole="button"
              accessibilityLabel="Remove image"
            >
              <Ionicons name="close" size={12} color={t.text} />
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={attach}
          disabled={disabled || isStreaming}
          hitSlop={6}
          style={styles.attach}
          accessibilityRole="button"
          accessibilityLabel="Attach an image"
        >
          <Ionicons name="image-outline" size={20} color={disabled || isStreaming ? t.mutedStrong : t.muted} />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={disabled ? 'Connecting…' : image ? 'Add a caption' : placeholder}
          placeholderTextColor={t.muted}
          multiline
          rows={1}
          maxLength={8000}
          editable={!disabled}
          blurOnSubmit={false}
          onKeyPress={(e) => {
            // Hardware keyboards / web: Enter sends, Shift+Enter breaks the line.
            if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
              e.preventDefault?.();
              submit();
            }
          }}
          accessibilityLabel="Message"
          style={[styles.input, { color: t.textStrong, fontFamily: t.font.regular, fontSize: t.type.body, lineHeight: Math.round(t.type.body * 1.5) }]}
        />
        {accessory}
        {isStreaming ? (
          <Pressable
            onPress={() => { tap(); onAbort?.(); }}
            style={[styles.send, { width: t.size.sendButton + 4, height: t.size.sendButton + 4, backgroundColor: t.textStrong }]}
            accessibilityRole="button"
            accessibilityLabel="Stop generating"
          >
            <Ionicons name="stop" size={14} color={t.bg} />
          </Pressable>
        ) : (
          <Pressable
            onPress={submit}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.send,
              {
                width: t.size.sendButton + 4,
                height: t.size.sendButton + 4,
                backgroundColor: t.accent,
                opacity: canSend ? 1 : 0.3,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend }}
          >
            <Ionicons name="arrow-up" size={18} color={t.accentForeground} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    paddingLeft: 6,
    paddingRight: 8,
    paddingVertical: 6,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  attach: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, minHeight: 38, maxHeight: 140, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 2, outlineStyle: 'none' },
  send: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  atts: { flexDirection: 'row', paddingLeft: 8, paddingTop: 6, paddingBottom: 4 },
  att: { width: 56, height: 56, borderRadius: 10, borderWidth: 1 },
  attX: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
