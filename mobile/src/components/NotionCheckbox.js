import React, { useEffect, useRef } from 'react';
import { TouchableOpacity, Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

/**
 * Stylish Notion-style animated checkbox
 * - Smooth scale + fade animation on toggle
 * - Glow effect when checked
 * - Syncs with Notion via callback
 */
export function NotionCheckbox({ checked, onChange, size = 22, disabled = false }) {
  const scaleAnim = useRef(new Animated.Value(checked ? 1 : 0)).current;
  const glowAnim = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: checked ? 1 : 0,
        friction: 5,
        tension: 100,
        useNativeDriver: true,
      }),
      Animated.timing(glowAnim, {
        toValue: checked ? 1 : 0,
        duration: 200,
        useNativeDriver: false,
      }),
    ]).start();
  }, [checked]);

  const handlePress = () => {
    if (disabled) return;
    onChange?.(!checked);
  };

  const boxSize = size;
  const iconSize = size - 6;

  const backgroundColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', COLORS.success + '22'],
  });

  const borderColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [COLORS.border, COLORS.success],
  });

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Animated.View
        style={[
          styles.box,
          {
            width: boxSize,
            height: boxSize,
            borderRadius: boxSize / 4,
            backgroundColor,
            borderColor,
          },
          disabled && styles.disabled,
        ]}
      >
        <Animated.View
          style={{
            transform: [
              {
                scale: scaleAnim.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0.5, 1.2, 1],
                }),
              },
            ],
            opacity: scaleAnim,
          }}
        >
          <Ionicons name="checkmark" size={iconSize} color={COLORS.success} />
        </Animated.View>
      </Animated.View>
      {/* Glow effect */}
      {checked && (
        <View style={[styles.glow, { width: boxSize + 8, height: boxSize + 8, borderRadius: (boxSize + 8) / 4 }]} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.5,
  },
  glow: {
    position: 'absolute',
    top: -4,
    left: -4,
    backgroundColor: COLORS.success + '11',
    zIndex: -1,
  },
});
