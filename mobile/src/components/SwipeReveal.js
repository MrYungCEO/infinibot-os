/**
 * SwipeReveal — wrapper for ReanimatedSwipeable action panels.
 *
 * gesture-handler 3 removed the legacy `Swipeable`; its replacement
 * (`react-native-gesture-handler/ReanimatedSwipeable`) keeps the action
 * panels mounted behind the row instead of parking them off-screen, so they
 * show through our translucent glass rows at rest. The action renderers get
 * SharedValues (`progress` 0→1, `translation` in px); feed one in as `value`
 * and the panel fades/slides in only while the row is swiped.
 */
import React from 'react';
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from 'react-native-reanimated';

export function SwipeReveal({
  value,
  inputRange = [0, 1],
  opacityRange = [0, 1],
  translateRange,
  style,
  children,
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(value.value, inputRange, opacityRange, Extrapolation.CLAMP),
    ...(translateRange
      ? { transform: [{ translateX: interpolate(value.value, inputRange, translateRange, Extrapolation.CLAMP) }] }
      : null),
  }));
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

export default SwipeReveal;
