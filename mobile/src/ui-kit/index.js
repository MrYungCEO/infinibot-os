/**
 * InfiniBot mobile UI kit — the single import surface.
 *
 *   import { Screen, AppHeader, Card, ListRow, StatCard, Chip, Button } from '../ui-kit';
 *
 * Rules of the kit (full rationale in mobile/design-system/MASTER.md):
 *   · Colors come from the live theme (useUIKit().colors) — never a hex literal.
 *   · Spacing/radii come from SPACE/RADIUS — never a hand-written pixel gap.
 *   · Gold is borders, hairlines and washes. The only sanctioned gold fills
 *     are Button variant="primary" and a determinate ProgressBar fill.
 *   · Every interactive element is >= 44x44 of tap area and carries an
 *     accessibilityLabel.
 *   · No text below 12px, ever.
 *   · Data (IDs, counts, metrics, terminal output) is monospaced; prose is not.
 *
 * Do not add a component here without also adding it to MASTER.md's inventory.
 */

// tokens + hooks
export {
  SPACE,
  RADIUS,
  HIT,
  MOTION,
  ELEVATION,
  MIN_FONT_SIZE,
  MONO_FAMILY,
  useUIKit,
  makeType,
  staggerDelay,
  blurFor,
} from './tokens';
export { useReducedMotion, a11yPress } from './a11y';

// layout
export { Screen, DOCK_SPACE } from './Screen';
export { AppHeader, HeaderAction } from './AppHeader';
export { SectionTitle } from './SectionTitle';
export { Divider } from './Divider';

// surfaces
export { Card, resolveTint } from './Card';
export { StatCard } from './StatCard';
export { ListRow } from './ListRow';

// controls
export { Button, IconButton } from './Button';
export { Field, Input } from './Field';
export { Tabs, SegmentedControl } from './Tabs';

// status vocabulary
export {
  Chip,
  Badge,
  StatusChip,
  PriorityChip,
  PRIORITY_META,
  normalizePriority,
  toneForStatus,
  toneColor,
} from './Chip';

// feedback
export { ProgressBar } from './ProgressBar';
export { Skeleton, SkeletonRow } from './Skeleton';
export { EmptyState } from './EmptyState';

// overlays
export { BottomSheet, Modal } from './Sheet';
