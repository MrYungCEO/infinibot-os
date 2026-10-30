#!/bin/bash
# Create a new Remotion project with optional templates

set -e

PROJECT_NAME=${1:-"my-remotion-video"}
TEMPLATE=${2:-""}

echo "🎬 Creating Remotion project: $PROJECT_NAME"

# Create project using Remotion CLI
npx create-video@latest "$PROJECT_NAME" --package-manager=npm

cd "$PROJECT_NAME"

# Apply template if specified
case "$TEMPLATE" in
    --template=chat|chat)
        echo "📱 Applying chat template..."
        
        # Create messages.json
        cat > src/messages.json << 'EOF'
[
  {"text": "Hey! What can you help me with?", "isUser": true, "delay": 0},
  {"text": "I can help you with anything! Ask me a question.", "isUser": false, "delay": 1000},
  {"text": "What's the weather like today?", "isUser": true, "delay": 2000},
  {"text": "☀️ It's sunny and 72°F - perfect weather!", "isUser": false, "delay": 3000}
]
EOF

        # Create ChatBubble component
        cat > src/ChatBubble.tsx << 'EOF'
import { interpolate, useCurrentFrame, useVideoConfig, spring } from "remotion";

type ChatBubbleProps = {
  text: string;
  isUser: boolean;
  startFrame: number;
};

export const ChatBubble: React.FC<ChatBubbleProps> = ({ text, isUser, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const progress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
  });
  
  const opacity = interpolate(progress, [0, 1], [0, 1]);
  const translateY = interpolate(progress, [0, 1], [20, 0]);
  
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
        opacity,
        transform: `translateY(${translateY}px)`,
      }}
    >
      <div
        style={{
          maxWidth: "70%",
          padding: "12px 16px",
          borderRadius: 18,
          backgroundColor: isUser ? "#007AFF" : "#E5E5EA",
          color: isUser ? "white" : "black",
          fontSize: 16,
        }}
      >
        {text}
      </div>
    </div>
  );
};
EOF

        echo "✅ Chat template applied!"
        echo "Edit src/messages.json to customize the conversation."
        ;;
        
    --template=title|title)
        echo "🎬 Applying title template..."
        
        # Create TitleCard component
        cat > src/TitleCard.tsx << 'EOF'
import { spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type TitleCardProps = {
  title: string;
  subtitle?: string;
};

export const TitleCard: React.FC<TitleCardProps> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  
  const titleProgress = spring({
    frame,
    fps,
    config: { damping: 200 },
  });
  
  const subtitleProgress = spring({
    frame: frame - 10,
    fps,
    config: { damping: 200 },
  });
  
  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#000",
      }}
    >
      <h1
        style={{
          color: "white",
          fontSize: 72,
          fontWeight: "bold",
          opacity: titleProgress,
          transform: `translateY(${interpolate(titleProgress, [0, 1], [50, 0])}px)`,
        }}
      >
        {title}
      </h1>
      {subtitle && (
        <p
          style={{
            color: "#888",
            fontSize: 32,
            marginTop: 16,
            opacity: subtitleProgress,
            transform: `translateY(${interpolate(subtitleProgress, [0, 1], [30, 0])}px)`,
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
};
EOF

        echo "✅ Title template applied!"
        ;;
        
    "")
        echo "ℹ️ No template specified. Using default Remotion starter."
        ;;
        
    *)
        echo "⚠️ Unknown template: $TEMPLATE"
        echo "Available templates: chat, title"
        ;;
esac

echo ""
echo "✅ Project created: $PROJECT_NAME"
echo ""
echo "Next steps:"
echo "  cd $PROJECT_NAME"
echo "  npm start         # Preview in browser"
echo "  npx remotion render MyComp out/video.mp4  # Render"
