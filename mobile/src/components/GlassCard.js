/**
 * @deprecated GlassCard is superseded by `Card` in mobile/src/ui-kit.
 *
 * This file is now a thin back-compat re-export so the ~29 screens that
 * already import GlassCard keep working. The prop surface is unchanged:
 * children, style, cornerAccents, glow, animated, delay, tint, intensity.
 *
 * New code: `import { Card } from '../ui-kit'`.
 */

import React from 'react';
import { Card } from '../ui-kit/Card';

export function GlassCard(props) {
  return <Card depth={1} {...props} />;
}

export default GlassCard;
