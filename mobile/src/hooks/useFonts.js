/**
 * Custom Font Loading Hook
 * Uses Inter (primary) and Space Grotesk (display) fonts, plus JetBrains
 * Mono (the web control UI's body font — the Knowledge Graph chrome uses it),
 * bundled from assets/fonts (SIL OFL, see JetBrainsMono-OFL.txt).
 */

import { useFonts as useExpoFonts } from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';

export function useFonts() {
  const [fontsLoaded, fontError] = useExpoFonts({
    // Inter - Primary UI font
    'Inter-Regular': Inter_400Regular,
    'Inter-Medium': Inter_500Medium,
    'Inter-SemiBold': Inter_600SemiBold,
    'Inter-Bold': Inter_700Bold,
    'Inter-ExtraBold': Inter_800ExtraBold,
    // Space Grotesk - Display/Logo font
    'SpaceGrotesk-Regular': SpaceGrotesk_400Regular,
    'SpaceGrotesk-Medium': SpaceGrotesk_500Medium,
    'SpaceGrotesk-SemiBold': SpaceGrotesk_600SemiBold,
    'SpaceGrotesk-Bold': SpaceGrotesk_700Bold,
    // JetBrains Mono - the web UI's body / chrome font
    'JetBrainsMono-Regular': require('../../assets/fonts/JetBrainsMono_400Regular.ttf'),
    'JetBrainsMono-Medium': require('../../assets/fonts/JetBrainsMono_500Medium.ttf'),
    'JetBrainsMono-SemiBold': require('../../assets/fonts/JetBrainsMono_600SemiBold.ttf'),
    'JetBrainsMono-Bold': require('../../assets/fonts/JetBrainsMono_700Bold.ttf'),
  });

  return { fontsLoaded, fontError };
}

// Font family constants for easy use
export const FONT_FAMILY = {
  // Primary UI
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semiBold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  extraBold: 'Inter-ExtraBold',
  // Display/Logo
  display: 'SpaceGrotesk-Bold',
  displayMedium: 'SpaceGrotesk-Medium',
  displaySemiBold: 'SpaceGrotesk-SemiBold',
  displayRegular: 'SpaceGrotesk-Regular',
  // Mono (system)
  mono: 'monospace',
  // JetBrains Mono (bundled; the Knowledge Graph chrome)
  jetbrains: 'JetBrainsMono-Regular',
  jetbrainsMedium: 'JetBrainsMono-Medium',
  jetbrainsSemiBold: 'JetBrainsMono-SemiBold',
  jetbrainsBold: 'JetBrainsMono-Bold',
};

export default useFonts;
