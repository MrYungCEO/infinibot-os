/**
 * @deprecated GlassSurface is superseded by `Card` in mobile/src/ui-kit.
 *
 * Thin back-compat re-export. Original prop surface preserved:
 * children, style, intensity, tint, depth (1|2|3), radius, glow.
 *
 * New code: `import { Card } from '../ui-kit'`.
 */

import React from 'react';
import { Card } from '../ui-kit/Card';

export function GlassSurface({ depth = 1, radius = 16, ...rest }) {
  return <Card depth={depth} radius={radius} {...rest} />;
}

export default GlassSurface;
