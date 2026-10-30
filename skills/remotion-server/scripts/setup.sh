#!/bin/bash
# Setup script for Remotion headless rendering
# Installs browser dependencies required for Chrome Headless Shell

set -e

echo "🎬 Setting up Remotion headless rendering..."

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS=$(uname -s)
fi

case "$OS" in
    ubuntu|debian|pop)
        echo "📦 Installing dependencies for Ubuntu/Debian..."
        sudo apt-get update
        sudo apt-get install -y \
            libnss3 \
            libatk1.0-0 \
            libatk-bridge2.0-0 \
            libcups2 \
            libgbm1 \
            libpango-1.0-0 \
            libcairo2 \
            libxcomposite1 \
            libxdamage1 \
            libxfixes3 \
            libxrandr2 \
            libasound2 \
            libxss1 \
            libgtk-3-0
        ;;
    fedora|rhel|centos)
        echo "📦 Installing dependencies for Fedora/RHEL..."
        sudo dnf install -y \
            nss \
            atk \
            at-spi2-atk \
            cups-libs \
            mesa-libgbm \
            pango \
            cairo \
            libXcomposite \
            libXdamage \
            libXfixes \
            libXrandr \
            alsa-lib \
            libXScrnSaver \
            gtk3
        ;;
    arch|manjaro)
        echo "📦 Installing dependencies for Arch Linux..."
        sudo pacman -S --noconfirm \
            nss \
            atk \
            at-spi2-atk \
            cups \
            mesa \
            pango \
            cairo \
            libxcomposite \
            libxdamage \
            libxfixes \
            libxrandr \
            alsa-lib \
            libxss \
            gtk3
        ;;
    *)
        echo "⚠️ Unknown OS: $OS"
        echo "Please install browser dependencies manually."
        echo "See: https://www.remotion.dev/docs/miscellaneous/linux"
        exit 1
        ;;
esac

echo "✅ Browser dependencies installed!"
echo ""
echo "Next steps:"
echo "  1. Create a project: bash scripts/create.sh my-video"
echo "  2. cd my-video"
echo "  3. Render: npx remotion render MyComp out/video.mp4"
