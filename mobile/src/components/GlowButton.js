/**
 * @deprecated GlowButton is superseded by `Button` in mobile/src/ui-kit.
 * Kept as a thin back-compat re-export.
 *
 * Original prop surface: onPress, title, icon, style, textStyle, disabled,
 * variant ('primary' | 'outline' | 'ghost'), size ('sm' | 'md' | 'lg').
 *
 * One compatibility note: GlowButton's `icon` was rendered as raw <Text>, so
 * callers could pass an emoji. The kit's Button treats `icon` as an Ionicons
 * name (SVG only — no emoji in the UI). Anything that doesn't look like an
 * icon name is folded into the label instead of being silently dropped.
 *
 * New code: `import { Button } from '../ui-kit'`.
 */

import React from 'react';
import { Button } from '../ui-kit/Button';

const IONICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function GlowButton({ icon, title, ...rest }) {
  const isIconName = typeof icon === 'string' && IONICON_NAME.test(icon);
  return (
    <Button
      icon={isIconName ? icon : undefined}
      title={isIconName || !icon ? title : `${icon} ${title || ''}`.trim()}
      {...rest}
    />
  );
}

export default GlowButton;
