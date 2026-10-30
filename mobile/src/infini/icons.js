/**
 * Hairline stroke icons for the InfiniBot call page (react-native-svg).
 * Same drawing language as the web control UI's icons.ts (24-unit grid,
 * round caps, currentColor-style `color` prop) — no emoji anywhere.
 */
import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

function Base({ size = 22, color = '#f6d27a', strokeWidth = 1.8, children }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export const NoteIcon = (p) => (
  <Base {...p}>
    <Path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z" />
    <Path d="M14 2v6h6M8 13h8M8 17h5" />
  </Base>
);

export const IdeaIcon = (p) => (
  <Base {...p}>
    <Path d="M9 18h6M10 22h4" />
    <Path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
  </Base>
);

export const TaskIcon = (p) => (
  <Base {...p}>
    <Rect x="3" y="3" width="18" height="18" rx="4" />
    <Path d="m8 12 3 3 5-6" />
  </Base>
);

export const ProjectIcon = (p) => (
  <Base {...p}>
    <Path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <Path d="M12 10v6M9 13h6" />
  </Base>
);

export const LogIcon = (p) => (
  <Base {...p}>
    <Path d="M3 12h4l3-8 4 16 3-8h4" />
  </Base>
);

export const MicIcon = (p) => (
  <Base {...p}>
    <Rect x="9" y="2" width="6" height="12" rx="3" />
    <Path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
  </Base>
);

export const KeyboardIcon = (p) => (
  <Base {...p}>
    <Rect x="2" y="5" width="20" height="14" rx="3" />
    <Path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 15.5h6" />
  </Base>
);

export const SlidersIcon = (p) => (
  <Base {...p}>
    <Path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
    <Circle cx="16" cy="6" r="2" />
    <Circle cx="10" cy="12" r="2" />
    <Circle cx="18" cy="18" r="2" />
  </Base>
);

export const TerminalIcon = (p) => (
  <Base {...p}>
    <Rect x="2" y="4" width="20" height="16" rx="3" />
    <Path d="m6 9 3 3-3 3M12 15h6" />
  </Base>
);

export const ChatLinesIcon = (p) => (
  <Base {...p}>
    <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <Path d="M8 9h8M8 13h5" />
  </Base>
);

export const CloseIcon = (p) => (
  <Base {...p}>
    <Path d="M18 6 6 18M6 6l12 12" />
  </Base>
);

export const PhoneOffIcon = (p) => (
  <Base {...p}>
    <Path d="M10.7 13.3a13 13 0 0 1-2.4-3.2l1.4-1.4a2 2 0 0 0 .4-2.2L9 3.6A2 2 0 0 0 6.7 2.5L4 3.3A2 2 0 0 0 2.6 5.5 19 19 0 0 0 8 16M13 15.6a19 19 0 0 0 5.5 2.4 2 2 0 0 0 2.2-1.4l.8-2.7a2 2 0 0 0-1.1-2.3l-2.9-1.1a2 2 0 0 0-2.2.4l-.6.6" />
    <Path d="M2 2l20 20" />
  </Base>
);

export const ChevronIcon = ({ open, ...p }) => (
  <Base {...p}>
    <Path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
  </Base>
);

export const CheckIcon = (p) => (
  <Base {...p}>
    <Path d="M20 6 9 17l-5-5" />
  </Base>
);

export const CloudIcon = (p) => (
  <Base {...p}>
    <Path d="M17.5 19H8a5 5 0 1 1 .9-9.9A6 6 0 0 1 20 11.5a3.8 3.8 0 0 1-2.5 7.5z" />
  </Base>
);

export const ChipIcon = (p) => (
  <Base {...p}>
    <Rect x="5" y="5" width="14" height="14" rx="2" />
    <Path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
  </Base>
);

export const RetryIcon = (p) => (
  <Base {...p}>
    <Path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <Path d="M3 3v5h5" />
  </Base>
);

/** "Hey Infini" always-on listening badge: an ear. */
export const EarIcon = (p) => (
  <Base {...p}>
    <Path d="M6 8.5a6 6 0 0 1 12 0c0 3.2-2.6 4.3-3.4 6.2-.6 1.5-.9 3.3-2.9 4.6-1.6 1-3.7.4-4.4-1.2" />
    <Path d="M9.2 9a2.8 2.8 0 0 1 5.6 0c0 1.5-1.4 2-1.4 3.2" />
  </Base>
);

/** Mic muted: the mic with a slash (lucide mic-off geometry). */
export const MicOffIcon = (p) => (
  <Base {...p}>
    <Path d="M2 2l20 20" />
    <Path d="M18.9 13.6A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5" />
    <Path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1" />
    <Path d="M12 19v3M8 22h8" />
  </Base>
);

/** Speaker on: a speaker with two sound waves. */
export const SpeakerIcon = (p) => (
  <Base {...p}>
    <Path d="M11 5 6 9H3v6h3l5 4z" />
    <Path d="M15.5 8.5a5 5 0 0 1 0 7M18.9 5.1a10 10 0 0 1 0 13.8" />
  </Base>
);

/** Speaker muted: a speaker with a cross. */
export const SpeakerOffIcon = (p) => (
  <Base {...p}>
    <Path d="M11 5 6 9H3v6h3l5 4z" />
    <Path d="m22 9-6 6M16 9l6 6" />
  </Base>
);

export const PlusIcon = (p) => (
  <Base {...p}>
    <Path d="M12 5v14M5 12h14" />
  </Base>
);

export const TrashIcon = (p) => (
  <Base {...p}>
    <Path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Base>
);

/** Diagnostics: a pulse in a frame. */
export const PulseIcon = (p) => (
  <Base {...p}>
    <Rect x="2" y="4" width="20" height="16" rx="3" />
    <Path d="M5 12h3l2-4 3 8 2-4h4" />
  </Base>
);

// ── chat composer (group chats: model / thinking / attachments / commands) ──

export const PaperclipIcon = (p) => (
  <Base {...p}>
    <Path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </Base>
);

export const BrainIcon = (p) => (
  <Base {...p}>
    <Path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .6 6.6A4 4 0 1 0 12 18z" />
    <Path d="M12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.6 6.6A4 4 0 1 1 12 18z" />
    <Path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </Base>
);

export const SearchIcon = (p) => (
  <Base {...p}>
    <Circle cx="11" cy="11" r="7" />
    <Path d="m21 21-4.3-4.3" />
  </Base>
);

export const ChevronDownIcon = (p) => (
  <Base {...p}>
    <Path d="m6 9 6 6 6-6" />
  </Base>
);

export const UsersIcon = (p) => (
  <Base {...p}>
    <Circle cx="9" cy="8" r="3.5" />
    <Path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6" />
  </Base>
);

/** The logo's ∞ — used for the dock's call button. */
export const InfinityGlyph = ({ size = 22, color = '#f6d27a', strokeWidth = 2.2 }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M12 12c-1.8-2.4-3.3-3.6-5-3.6a3.6 3.6 0 0 0 0 7.2c1.7 0 3.2-1.2 5-3.6zm0 0c1.8 2.4 3.3 3.6 5 3.6a3.6 3.6 0 0 0 0-7.2c-1.7 0-3.2 1.2-5 3.6z" />
  </Svg>
);

export const CAPTURE_ICONS = {
  note: NoteIcon,
  idea: IdeaIcon,
  task: TaskIcon,
  project: ProjectIcon,
  log: LogIcon,
};

export const KeyIcon = (p) => (
  <Base {...p}>
    <Circle cx="7.5" cy="15.5" r="5.5" />
    <Path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
  </Base>
);

export const ServerIcon = (p) => (
  <Base {...p}>
    <Rect x="2" y="2" width="20" height="8" rx="2" />
    <Rect x="2" y="14" width="20" height="8" rx="2" />
    <Path d="M6 6h.01M6 18h.01" />
  </Base>
);

export const BotIcon = (p) => (
  <Base {...p}>
    <Path d="M12 8V4H8" />
    <Rect x="4" y="8" width="16" height="12" rx="2" />
    <Path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
  </Base>
);
