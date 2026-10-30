---
name: text-animations
description: Typography and text animation patterns for Remotion.
metadata:
  tags: typography, text, typewriter, highlighter ken
---

## Text animations

Based on `useCurrentFrame()`, reduce the string character by character to create a typewriter effect.

## Typewriter Effect

```tsx
import { useCurrentFrame, useVideoConfig } from "remotion";

export const Typewriter: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // Characters per second
  const charsPerSecond = 20;
  const charsToShow = Math.floor((frame / fps) * charsPerSecond);
  const displayText = text.slice(0, charsToShow);
  
  // Blinking cursor
  const showCursor = Math.floor(frame / (fps / 2)) % 2 === 0;
  
  return (
    <div style={{ fontFamily: "monospace", fontSize: 32 }}>
      {displayText}
      {showCursor && <span style={{ opacity: 1 }}>|</span>}
    </div>
  );
};
```

Always use string slicing for typewriter effects. Never use per-character opacity.

## Word Highlighting

```tsx
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const WordHighlight: React.FC<{ text: string; highlightWord: string }> = ({
  text,
  highlightWord,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const highlightProgress = interpolate(
    frame,
    [0.5 * fps, 1 * fps],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  
  const words = text.split(" ");
  
  return (
    <div style={{ fontSize: 32 }}>
      {words.map((word, i) => {
        const isHighlighted = word.toLowerCase().includes(highlightWord.toLowerCase());
        return (
          <span
            key={i}
            style={{
              backgroundColor: isHighlighted
                ? `rgba(255, 230, 0, ${highlightProgress})`
                : "transparent",
              padding: isHighlighted ? "2px 4px" : 0,
            }}
          >
            {word}{" "}
          </span>
        );
      })}
    </div>
  );
};
```
