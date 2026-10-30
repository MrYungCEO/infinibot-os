/**
 * Standalone test harness for <world-audio> + <cosmetics-picker>.
 * Served by vite dev at /world-cosmetics-test.html. Exposes window hooks the
 * visual-verify-loop / puppeteer driver uses to cycle themes and fire sounds.
 */
import "./src/ui/components/world-audio.js";
import "./src/ui/components/cosmetics-picker.js";
import {
  COSMETIC_THEMES,
  applyTheme,
  initCosmetics,
  getActiveTheme,
} from "./../src/cosmetics/index.js";
import { getWorldSounds } from "./../src/audio/world-sounds.js";

initCosmetics();

document.body.appendChild(document.createElement("world-audio"));
document.body.appendChild(document.createElement("cosmetics-picker"));

function syncLabel() {
  const el = document.getElementById("theme-name");
  if (el) el.textContent = getActiveTheme().label;
}
syncLabel();
window.addEventListener("infinibot:world-theme-change", syncLabel);

declare global {
  interface Window {
    __testCycleTheme: (id: string) => void;
    __testFire: (kind: string, success?: boolean) => Promise<string>;
    __testThemes: string[];
  }
}

window.__testThemes = COSMETIC_THEMES.map((t) => t.id);
window.__testCycleTheme = (id: string) => {
  applyTheme(id);
};

// Fire every synth voice with a forced-unlocked context, collecting errors.
window.__testFire = async (kind: string, success?: boolean) => {
  const s = getWorldSounds();
  s.setMuted(false);
  await s.unlock();
  try {
    window.dispatchEvent(
      new CustomEvent("infinibot:world-event", { detail: { kind, success } }),
    );
    return "ok";
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
};
