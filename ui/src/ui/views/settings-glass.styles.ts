import { html } from "lit";

/**
 * Page-scoped glass treatment for Settings and Channels.
 *
 * These styles deliberately derive every colour from the host application's
 * existing theme variables. That keeps the pages compatible with the shared
 * dark/light theme work without introducing a second global token source.
 */
export const settingsGlassStyles = html`
  <style>
    .glass-settings {
      --gs-gold: var(--glass-gold, var(--g-primary, #d4af37));
      --gs-1: var(--glass-1, color-mix(in srgb, var(--panel) 76%, transparent));
      --gs-2: var(--glass-2, color-mix(in srgb, var(--panel) 86%, transparent));
      --gs-3: var(--glass-3, color-mix(in srgb, var(--bg-elevated) 90%, transparent));
      --gs-4: var(--glass-4, color-mix(in srgb, var(--bg-elevated) 96%, transparent));
      --gs-stroke: var(--glass-stroke, color-mix(in srgb, var(--gs-gold) 18%, var(--border)));
      --gs-stroke-strong: var(--glass-stroke-strong, color-mix(in srgb, var(--gs-gold) 42%, var(--border-strong)));
      --gs-glow: color-mix(in srgb, var(--gs-gold) 30%, transparent);
      --gs-glow-soft: color-mix(in srgb, var(--gs-gold) 12%, transparent);
      --gs-blur: var(--glass-blur, blur(24px) saturate(145%));
      --gs-elev-1: var(--glass-elev-1, 0 8px 24px color-mix(in srgb, var(--bg) 42%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent));
      --gs-elev-2: var(--glass-elev-2, 0 18px 48px color-mix(in srgb, var(--bg) 48%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--bg) 18%, transparent));
      --gs-elev-3: var(--glass-elev-3, 0 24px 64px color-mix(in srgb, var(--bg) 54%, transparent), 0 0 28px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 11%, transparent));
      --gs-elev-4: var(--glass-elev-4, 0 32px 96px color-mix(in srgb, var(--bg) 64%, transparent), 0 0 42px var(--gs-glow), inset 0 1px 0 color-mix(in srgb, var(--text) 12%, transparent));
      position: relative;
      isolation: isolate;
      color: var(--text);
    }

    .glass-settings::before,
    .glass-settings::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: -1;
    }

    .glass-settings::before {
      background:
        radial-gradient(circle at 12% -8%, var(--gs-glow), transparent 34%),
        radial-gradient(circle at 88% 6%, var(--gs-glow-soft), transparent 30%),
        radial-gradient(circle at 52% 112%, color-mix(in srgb, var(--gs-gold) 7%, transparent), transparent 38%);
    }

    .glass-settings::after {
      opacity: 0.28;
      background-image:
        repeating-linear-gradient(118deg, transparent 0 3px, color-mix(in srgb, var(--text) 2%, transparent) 3px 4px),
        linear-gradient(180deg, color-mix(in srgb, var(--text) 4%, transparent), transparent 18%, color-mix(in srgb, var(--bg) 18%, transparent));
      mix-blend-mode: soft-light;
    }

    .glass-settings.config-layout {
      margin: 16px 0 0;
      border: 1px solid var(--gs-stroke);
      border-radius: 24px;
      background: var(--gs-1);
      box-shadow: var(--gs-elev-2);
      backdrop-filter: var(--gs-blur);
      -webkit-backdrop-filter: var(--gs-blur);
    }

    .glass-settings .config-sidebar {
      background: linear-gradient(180deg, var(--gs-3), var(--gs-1));
      border-color: var(--gs-stroke);
      box-shadow: var(--gs-elev-1);
    }

    .glass-settings .config-sidebar__header {
      min-height: 44px;
      border-color: var(--gs-stroke);
    }

    .glass-settings .config-sidebar__title {
      color: var(--text);
      letter-spacing: 0.16em;
    }

    .glass-settings .config-sidebar__title::after {
      content: "CONTROL CENTER";
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.22em;
    }

    .glass-settings .config-search__input,
    .glass-settings .cfg-input,
    .glass-settings .cfg-select,
    .glass-settings .cfg-textarea,
    .glass-settings .cfg-number,
    .glass-settings .config-raw-field textarea {
      color: var(--text);
      border-color: var(--gs-stroke);
      background: var(--gs-2);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent), 0 8px 24px color-mix(in srgb, var(--bg) 18%, transparent);
    }

    .glass-settings .config-search__input:focus,
    .glass-settings .cfg-input:focus,
    .glass-settings .cfg-select:focus,
    .glass-settings .cfg-textarea:focus,
    .glass-settings .cfg-number:focus-within,
    .glass-settings .config-raw-field textarea:focus {
      border-color: var(--gs-stroke-strong);
      background: var(--gs-4);
      box-shadow: 0 0 0 3px var(--gs-glow-soft), 0 0 28px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent);
      outline: none;
    }

    .glass-settings .config-search__clear,
    .glass-settings .cfg-input__reset,
    .glass-settings .cfg-number__btn,
    .glass-settings .cfg-array__add,
    .glass-settings .cfg-map__add {
      color: var(--muted);
      background: var(--gs-2);
      border-color: var(--gs-stroke);
    }

    .glass-settings .config-search__clear svg,
    .glass-settings .cfg-input__reset svg,
    .glass-settings .cfg-number__btn svg {
      width: 15px;
      height: 15px;
    }

    .glass-settings .config-nav__item {
      position: relative;
      min-height: 42px;
      border: 1px solid transparent;
      border-radius: 12px;
      color: var(--muted);
      overflow: hidden;
    }

    .glass-settings .config-nav__item::before {
      content: "";
      position: absolute;
      inset: 7px auto 7px 0;
      width: 2px;
      border-radius: var(--radius-full);
      background: var(--gs-gold);
      box-shadow: 0 0 14px var(--gs-gold);
      opacity: 0;
      transform: scaleY(0.4);
      transition: opacity var(--duration-fast) ease, transform var(--duration-fast) ease;
    }

    .glass-settings .config-nav__item:hover {
      transform: translateX(2px);
      color: var(--text);
      border-color: var(--gs-stroke);
      background: var(--gs-1);
    }

    .glass-settings .config-nav__item.active {
      color: var(--gs-gold);
      border-color: var(--gs-stroke-strong);
      background: linear-gradient(110deg, var(--gs-glow-soft), var(--gs-2));
      box-shadow: 0 8px 24px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
    }

    .glass-settings .config-nav__item.active::before {
      opacity: 1;
      transform: scaleY(1);
    }

    .glass-settings .config-mode-toggle,
    .glass-settings .config-subnav__item {
      border-color: var(--gs-stroke);
      background: var(--gs-2);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent);
    }

    .glass-settings .config-mode-toggle__btn.active,
    .glass-settings .config-subnav__item.active,
    .glass-settings .cfg-segmented__btn.active {
      color: var(--bg);
      border-color: var(--gs-stroke-strong);
      background: linear-gradient(145deg, color-mix(in srgb, var(--gs-gold) 88%, var(--text)), var(--gs-gold));
      box-shadow: 0 8px 22px var(--gs-glow), inset 0 1px 0 color-mix(in srgb, var(--text) 28%, transparent);
    }

    .glass-settings .config-main {
      background: transparent;
    }

    .glass-settings .config-actions {
      position: sticky;
      top: 0;
      z-index: 12;
      border-color: var(--gs-stroke);
      background: var(--gs-3);
      box-shadow: var(--gs-elev-1);
      backdrop-filter: var(--gs-blur);
      -webkit-backdrop-filter: var(--gs-blur);
    }

    .glass-settings .config-save-state {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--ok);
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.02em;
    }

    .glass-settings .config-save-state svg {
      width: 17px;
      height: 17px;
      padding: 3px;
      border-radius: var(--radius-full);
      border: 1px solid color-mix(in srgb, var(--ok) 38%, transparent);
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      box-shadow: 0 0 16px color-mix(in srgb, var(--ok) 20%, transparent);
      animation: settings-saved-in 420ms var(--ease-out) both;
    }

    .glass-settings .config-actions .btn {
      min-height: 36px;
      border-color: var(--gs-stroke);
      background: var(--gs-2);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent);
      transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
    }

    .glass-settings .config-actions .btn:hover:not(:disabled) {
      transform: translateY(-1px);
      border-color: var(--gs-stroke-strong);
      box-shadow: 0 8px 20px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent);
    }

    .glass-settings .config-actions .btn.primary {
      color: var(--bg);
      background: linear-gradient(145deg, color-mix(in srgb, var(--gs-gold) 82%, var(--text)), var(--gs-gold));
      box-shadow: 0 8px 24px var(--gs-glow), inset 0 1px 0 color-mix(in srgb, var(--text) 26%, transparent);
    }

    .glass-settings .config-actions .btn:disabled,
    .glass-settings .config-actions .btn.primary:disabled {
      color: var(--muted);
      background: var(--gs-1);
      border-color: var(--gs-stroke);
      box-shadow: none;
      opacity: 0.55;
      cursor: not-allowed;
    }

    .glass-settings .config-section-hero,
    .glass-settings .config-subnav {
      border-color: var(--gs-stroke);
      background: linear-gradient(110deg, var(--gs-glow-soft), var(--gs-1) 44%, transparent);
    }

    .glass-settings .config-section-hero__icon,
    .glass-settings .config-section-card__icon {
      color: var(--gs-gold);
      filter: drop-shadow(0 0 11px var(--gs-glow));
    }

    .glass-settings .config-section-hero__title,
    .glass-settings .config-section-card__title {
      color: var(--text);
    }

    .glass-settings .config-diff,
    .glass-settings .config-section-card,
    .glass-settings .cfg-object,
    .glass-settings .cfg-array,
    .glass-settings .cfg-map {
      border-color: var(--gs-stroke);
      background: var(--gs-2);
      box-shadow: var(--gs-elev-2);
    }

    .glass-settings .config-section-card {
      border-radius: 18px;
      transition: transform var(--duration-normal) var(--ease-out), border-color var(--duration-normal) ease, box-shadow var(--duration-normal) ease;
    }

    .glass-settings .config-section-card:hover {
      transform: translateY(-2px);
      border-color: var(--gs-stroke-strong);
      box-shadow: var(--gs-elev-3);
    }

    .glass-settings .config-section-card__header,
    .glass-settings .cfg-object__header,
    .glass-settings .cfg-array__header,
    .glass-settings .cfg-map__header,
    .glass-settings .cfg-array__item-header {
      border-color: var(--gs-stroke);
      background: linear-gradient(110deg, var(--gs-glow-soft), var(--gs-1) 48%, transparent);
    }

    .glass-settings .cfg-toggle-row {
      border-color: var(--gs-stroke);
      background: var(--gs-1);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent);
    }

    .glass-settings .cfg-toggle-row:hover:not(.disabled) {
      transform: translateY(-1px);
      border-color: var(--gs-stroke-strong);
      background: var(--gs-3);
      box-shadow: 0 10px 26px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
    }

    .glass-settings .cfg-toggle__track {
      background: var(--gs-3);
      border-color: var(--gs-stroke);
      box-shadow: inset 0 2px 6px color-mix(in srgb, var(--bg) 28%, transparent);
    }

    .glass-settings .cfg-toggle__track::after {
      background: var(--muted);
    }

    .glass-settings .cfg-toggle input:checked + .cfg-toggle__track {
      border-color: color-mix(in srgb, var(--gs-gold) 62%, var(--border));
      background: color-mix(in srgb, var(--gs-gold) 28%, var(--gs-3));
      box-shadow: inset 0 1px 5px color-mix(in srgb, var(--bg) 24%, transparent), 0 0 18px var(--gs-glow-soft);
    }

    .glass-settings .cfg-toggle input:checked + .cfg-toggle__track::after {
      background: var(--gs-gold);
      box-shadow: 0 0 13px var(--gs-glow);
    }

    .glass-settings .cfg-segmented {
      border-color: var(--gs-stroke);
      background: var(--gs-1);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent);
    }

    .glass-settings .cfg-field--error {
      border-color: color-mix(in srgb, var(--danger) 36%, var(--border));
      background: color-mix(in srgb, var(--danger) 8%, var(--gs-2));
    }

    .glass-settings .cfg-field__validation {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--danger);
      font-size: 11px;
      line-height: 1.4;
    }

    .glass-settings .cfg-field__validation::before {
      content: "";
      width: 5px;
      height: 5px;
      flex: none;
      border-radius: var(--radius-full);
      background: var(--danger);
      box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 48%, transparent);
    }

    .glass-settings [aria-invalid="true"] {
      border-color: color-mix(in srgb, var(--danger) 65%, var(--border-strong));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 12%, transparent);
    }

    .glass-settings .cfg-range {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) 94px;
      gap: 14px;
      align-items: center;
    }

    .glass-settings .cfg-range__slider {
      width: 100%;
      height: 4px;
      accent-color: var(--gs-gold);
      cursor: pointer;
      filter: drop-shadow(0 0 8px var(--gs-glow-soft));
    }

    .glass-settings .cfg-array__item,
    .glass-settings .cfg-map__item,
    .glass-settings .config-diff__item {
      border-color: var(--gs-stroke);
      background: var(--gs-1);
    }

    .glass-settings .config-loading--skeleton {
      align-items: stretch;
      padding: 8px;
    }

    .glass-settings .config-skeleton {
      display: grid;
      gap: 16px;
      padding: 22px;
      border: 1px solid var(--gs-stroke);
      border-radius: 18px;
      background: var(--gs-2);
      box-shadow: var(--gs-elev-2);
    }

    .glass-settings .config-skeleton__line {
      height: 13px;
      border-radius: var(--radius-full);
      background: linear-gradient(90deg, var(--gs-1), var(--gs-glow-soft), var(--gs-1));
      background-size: 220% 100%;
      animation: settings-shimmer 1.7s ease-in-out infinite;
    }

    .glass-settings .config-skeleton__line:first-child { width: 38%; height: 22px; }
    .glass-settings .config-skeleton__line:nth-child(3) { width: 82%; }
    .glass-settings .config-skeleton__line:nth-child(4) { width: 64%; }

    @keyframes settings-shimmer {
      from { background-position: 110% 0; }
      to { background-position: -110% 0; }
    }

    @keyframes settings-saved-in {
      0% { opacity: 0; transform: scale(0.65) rotate(-12deg); }
      70% { transform: scale(1.08) rotate(2deg); }
      100% { opacity: 1; transform: scale(1) rotate(0); }
    }

    @media (max-width: 768px) {
      .glass-settings.config-layout {
        height: auto;
        min-height: calc(100dvh - 120px);
        border-radius: 18px;
      }

      .glass-settings.config-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .glass-settings .config-sidebar {
        min-width: 0;
        max-height: none;
        overflow: visible;
      }

      .glass-settings .config-main { min-width: 0; }

      /* Search across settings stays available on phones. */
      .glass-settings .config-search {
        display: block;
        padding: 10px 14px 0;
      }

      .glass-settings .config-nav {
        min-width: 0;
        max-width: 100%;
        overflow-x: auto;
        scroll-snap-type: x proximity;
      }

      .glass-settings .config-nav__item { scroll-snap-align: start; }

      .glass-settings .config-sidebar__footer {
        display: block;
        padding: 0 14px 12px;
        border-top: none;
        background: transparent;
      }

      .glass-settings .config-nav {
        padding-bottom: 12px;
        scrollbar-width: none;
      }

      .glass-settings .config-nav::-webkit-scrollbar { display: none; }

      .glass-settings .config-nav__item {
        min-height: 40px;
        padding-inline: 12px;
      }

      .glass-settings .config-nav__item:hover { transform: none; }

      .glass-settings .config-actions {
        top: 0;
        padding: 12px;
      }

      .glass-settings .config-actions__right {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }

      .glass-settings .config-actions .btn {
        min-width: 0;
        padding-inline: 8px;
      }

      .glass-settings .config-content { padding: 14px; }
      .glass-settings .config-section-card__header,
      .glass-settings .config-section-card__content { padding: 16px; }
    }

    @media (max-width: 430px) {
      .glass-settings .config-sidebar__header { padding: 13px 14px; }
      .glass-settings .config-search { padding: 10px 12px; }
      .glass-settings .config-search__icon { left: 26px; }
      .glass-settings .config-nav__label { display: inline; }
      .glass-settings .config-nav__icon { width: 18px; height: 18px; }
      .glass-settings .config-section-hero { padding: 14px; }
      .glass-settings .config-section-hero__desc { white-space: normal; }
      .glass-settings .config-actions__left { justify-content: flex-start; }
      .glass-settings .cfg-range { grid-template-columns: 1fr; }
      .glass-settings .cfg-input-wrap { gap: 6px; }
      .glass-settings .cfg-array__header { align-items: flex-start; flex-wrap: wrap; }
      .glass-settings .cfg-array__add { margin-left: auto; }
    }

    @media (prefers-reduced-motion: reduce) {
      .glass-settings *,
      .glass-settings *::before,
      .glass-settings *::after {
        scroll-behavior: auto;
        animation-duration: 1ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 1ms !important;
      }
    }

    @media (prefers-reduced-transparency: reduce) {
      .glass-settings,
      .glass-settings .config-sidebar,
      .glass-settings .config-actions,
      .glass-settings .config-section-card,
      .glass-settings .cfg-object,
      .glass-settings .cfg-array,
      .glass-settings .cfg-map {
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        background: var(--panel);
      }
    }
  </style>
`;

export const channelsGlassStyles = html`
  <style>
    .channels-page {
      --gs-gold: var(--glass-gold, var(--g-primary, #d4af37));
      --gs-1: var(--glass-1, color-mix(in srgb, var(--panel) 76%, transparent));
      --gs-2: var(--glass-2, color-mix(in srgb, var(--panel) 86%, transparent));
      --gs-3: var(--glass-3, color-mix(in srgb, var(--bg-elevated) 92%, transparent));
      --gs-stroke: var(--glass-stroke, color-mix(in srgb, var(--gs-gold) 18%, var(--border)));
      --gs-stroke-strong: var(--glass-stroke-strong, color-mix(in srgb, var(--gs-gold) 40%, var(--border-strong)));
      --gs-glow: color-mix(in srgb, var(--gs-gold) 28%, transparent);
      --gs-glow-soft: color-mix(in srgb, var(--gs-gold) 11%, transparent);
      --gs-blur: var(--glass-blur, blur(24px) saturate(150%));
      --gs-elev-1: var(--glass-elev-1, 0 10px 30px color-mix(in srgb, var(--bg) 38%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent));
      --gs-elev-2: var(--glass-elev-2, 0 22px 62px color-mix(in srgb, var(--bg) 52%, transparent), 0 0 30px var(--gs-glow-soft), inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent));
      position: relative;
      isolation: isolate;
      padding: 4px;
      color: var(--text);
    }

    .channels-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 22px;
      align-items: end;
      margin-bottom: 20px;
      padding: 24px 26px;
      border: 1px solid var(--gs-stroke);
      border-radius: 22px;
      background: linear-gradient(125deg, var(--gs-glow-soft), var(--gs-2) 38%, var(--gs-1));
      box-shadow: var(--gs-elev-2);
      backdrop-filter: var(--gs-blur);
      -webkit-backdrop-filter: var(--gs-blur);
      overflow: hidden;
      position: relative;
    }

    .channels-hero::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(420px 220px at 0% 0%, var(--gs-glow-soft), transparent 70%),
        radial-gradient(360px 200px at 100% 100%, color-mix(in srgb, var(--gs-gold) 6%, transparent), transparent 70%);
    }

    .channels-hero > * { position: relative; }

    .channels-hero__eyebrow {
      color: var(--gs-gold);
      font-size: 10px;
      font-weight: 750;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }

    .channels-hero h2 {
      margin: 6px 0 5px;
      color: var(--text);
      font-size: clamp(24px, 3vw, 34px);
      font-weight: 650;
      letter-spacing: -0.035em;
    }

    .channels-hero p {
      max-width: 66ch;
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .channels-hero__aside {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .channels-stat {
      display: grid;
      min-width: 78px;
      padding: 10px 14px;
      border: 1px solid var(--gs-stroke);
      border-radius: 14px;
      background: var(--gs-1);
      box-shadow: var(--gs-elev-1);
      text-align: center;
    }

    .channels-stat strong { color: var(--gs-gold); font-size: 20px; line-height: 1; }
    .channels-stat span { margin-top: 4px; color: var(--muted); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }

    .channels-refresh {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      padding: 0;
      border: 1px solid var(--gs-stroke-strong);
      border-radius: 13px;
      color: var(--gs-gold);
      background: var(--gs-2);
      box-shadow: var(--gs-elev-1);
      cursor: pointer;
    }

    .channels-refresh svg { width: 18px; height: 18px; }
    .channels-refresh:hover:not(:disabled) { transform: translateY(-2px) rotate(8deg); box-shadow: 0 12px 30px var(--gs-glow); }
    .channels-refresh:focus-visible { outline: 2px solid var(--gs-gold); outline-offset: 3px; }

    .channels-page .channels-grid {
      gap: 18px;
      align-items: start;
    }

    .channels-page .channel-card {
      border-color: color-mix(in srgb, var(--brand) 28%, var(--gs-stroke));
      border-radius: 19px;
      background: linear-gradient(150deg, color-mix(in srgb, var(--brand) 8%, var(--gs-3)), var(--gs-1) 55%, color-mix(in srgb, var(--bg) 24%, var(--gs-2)));
      box-shadow: var(--gs-elev-2), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
      backdrop-filter: var(--gs-blur);
      -webkit-backdrop-filter: var(--gs-blur);
    }

    .channels-page .channel-card::before {
      background:
        radial-gradient(90% 42% at 18% -8%, color-mix(in srgb, var(--brand) 28%, transparent), transparent 68%),
        linear-gradient(180deg, color-mix(in srgb, var(--text) 5%, transparent), transparent 22%);
    }

    .channels-page .channel-card:hover {
      transform: translateY(-4px) scale(1.006);
      border-color: color-mix(in srgb, var(--brand) 54%, var(--gs-stroke));
      box-shadow: 0 28px 74px color-mix(in srgb, var(--bg) 58%, transparent), 0 0 42px color-mix(in srgb, var(--brand) 18%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 12%, transparent);
    }

    .channels-page .channel-card.is-disconnected {
      opacity: 0.82;
      filter: saturate(0.62);
    }

    .channels-page .channel-logo {
      width: 46px !important;
      height: 46px !important;
      border-color: color-mix(in srgb, var(--brand) 45%, var(--gs-stroke));
      background: color-mix(in srgb, var(--brand) 10%, var(--gs-2));
      box-shadow: 0 12px 30px color-mix(in srgb, var(--brand) 18%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 12%, transparent);
    }

    .channels-page .channel-logo--mark {
      border-color: color-mix(in srgb, var(--brand) 28%, transparent);
      background: color-mix(in srgb, var(--brand) 7%, transparent);
      box-shadow: 0 12px 30px color-mix(in srgb, var(--brand) 15%, transparent);
    }

    .channels-page .channel-card-heading .channel-title { color: var(--text); text-shadow: none; letter-spacing: -0.01em; text-transform: none; }
    .channels-page .channel-card-heading .channel-tagline { color: var(--muted); }

    .channels-page .channel-status-pill {
      border-color: color-mix(in srgb, currentColor 44%, var(--border));
      background: color-mix(in srgb, currentColor 9%, var(--gs-1));
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent);
    }

    .channels-page .channel-status-pill.connected { color: var(--ok); }
    .channels-page .channel-status-pill.error { color: var(--danger); }
    .channels-page .channel-status-pill.pending { color: var(--warn); }
    .channels-page .channel-status-pill.disconnected,
    .channels-page .channel-status-pill.unconfigured { color: var(--muted); }

    .channels-page .channel-card .status-list > div,
    .channels-page .account-card,
    .channels-page .channel-config-empty,
    .channels-page .channel-setup-note,
    .channels-page .nostr-profile,
    .channels-page .nostr-profile-form {
      border: 1px solid var(--gs-stroke);
      border-radius: 12px;
      background: var(--gs-1);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent);
    }

    .channels-page .channel-card .status-list > div { min-width: 0; padding: 9px 11px; }
    .channels-page .channel-card .status-list > div > span:last-child { color: var(--text); overflow-wrap: anywhere; }
    .channels-page .channel-card .status-list .label { color: var(--muted); }

    .channels-page .channel-advanced {
      margin-top: 14px;
      border: 1px solid var(--gs-stroke);
      border-radius: 13px;
      background: var(--gs-1);
      overflow: hidden;
    }

    .channels-page .channel-advanced > summary {
      padding: 12px 14px !important;
      color: var(--muted) !important;
      background: linear-gradient(110deg, color-mix(in srgb, var(--brand) 7%, transparent), transparent);
      list-style: none;
    }

    .channels-page .channel-advanced > summary::-webkit-details-marker { display: none; }
    .channels-page .channel-advanced[open] > summary { color: var(--text) !important; border-bottom: 1px solid var(--gs-stroke); }
    .channels-page .channel-advanced > :not(summary) { margin-inline: 14px; }
    .channels-page .channel-advanced > :last-child { margin-bottom: 14px; }

    .channels-page .channel-card .cfg-input,
    .channels-page .channel-card .cfg-select,
    .channels-page .channel-card .cfg-textarea,
    .channels-page .channel-card input,
    .channels-page .channel-card textarea {
      color: var(--text);
      border-color: color-mix(in srgb, var(--brand) 24%, var(--border));
      background: var(--gs-2);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent);
    }

    .channels-page .channel-card .cfg-input:focus,
    .channels-page .channel-card .cfg-select:focus,
    .channels-page .channel-card .cfg-textarea:focus,
    .channels-page .channel-card input:focus,
    .channels-page .channel-card textarea:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--brand) 68%, var(--border));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 12%, transparent), 0 0 22px color-mix(in srgb, var(--brand) 12%, transparent);
    }

    .channels-page .channel-card .btn.channel-btn,
    .channels-page .channel-card .btn {
      border-color: color-mix(in srgb, var(--brand) 30%, var(--gs-stroke));
      background: color-mix(in srgb, var(--brand) 7%, var(--gs-2));
      color: var(--text);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent);
    }

    .channels-page .channel-card .btn.channel-btn.primary,
    .channels-page .channel-card .btn.primary {
      color: var(--bg);
      background: linear-gradient(145deg, color-mix(in srgb, var(--brand) 72%, var(--text)), var(--brand));
      box-shadow: 0 10px 28px color-mix(in srgb, var(--brand) 22%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 24%, transparent);
    }

    .channels-page .channel-card .btn:disabled,
    .channels-page .channel-card .btn.primary:disabled {
      color: var(--muted);
      background: var(--gs-1);
      border-color: var(--gs-stroke);
      box-shadow: none;
      opacity: 0.55;
      cursor: not-allowed;
    }

    .channels-page .channel-card .btn.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

    .channels-page .channel-config-skeleton { display: grid; gap: 9px; padding: 12px 0; }
    .channels-page .channel-config-skeleton span { height: 10px; border-radius: var(--radius-full); background: linear-gradient(90deg, var(--gs-1), color-mix(in srgb, var(--brand) 12%, var(--gs-2)), var(--gs-1)); background-size: 220% 100%; animation: channels-shimmer 1.7s ease-in-out infinite; }
    .channels-page .channel-config-skeleton span:nth-child(2) { width: 82%; }
    .channels-page .channel-config-skeleton span:nth-child(3) { width: 64%; }
    .channels-page .channel-config-saved { align-self: center; color: var(--ok); font-size: 11px; font-weight: 650; animation: channel-saved-in 420ms ease both; }

    .channels-page .nostr-profile,
    .channels-page .nostr-profile-form { margin-top: 16px; padding: 14px; }
    .channels-page .nostr-profile__header,
    .channels-page .nostr-profile-form__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .channels-page .nostr-profile__title,
    .channels-page .nostr-profile-form__title { color: var(--text); font-weight: 650; }
    .channels-page .nostr-profile__empty,
    .channels-page .nostr-profile-form__account,
    .channels-page .nostr-profile-form__help,
    .channels-page .nostr-profile-form__dirty { color: var(--muted); font-size: 12px; }
    .channels-page .nostr-profile__avatar,
    .channels-page .nostr-profile-form__preview { width: 54px; height: 54px; border-radius: var(--radius-full); object-fit: cover; border: 1px solid color-mix(in srgb, var(--brand) 44%, var(--border)); box-shadow: 0 0 20px color-mix(in srgb, var(--brand) 18%, transparent); }
    .channels-page .nostr-profile-form__field { display: grid; gap: 5px; margin-bottom: 12px; }
    .channels-page .nostr-profile-form__field label { color: var(--text); font-size: 12px; font-weight: 620; }
    .channels-page .nostr-profile-form__error { color: var(--danger); font-size: 11px; }
    .channels-page .nostr-profile-form__advanced { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--gs-stroke); }
    .channels-page .nostr-profile-form__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }

    .channels-page .channels-health {
      margin-top: 20px;
      border: 1px solid var(--gs-stroke);
      border-radius: 18px;
      background: var(--gs-2);
      box-shadow: var(--gs-elev-2);
      backdrop-filter: var(--gs-blur);
      -webkit-backdrop-filter: var(--gs-blur);
    }

    .channels-page .channels-health .code-block { max-height: 320px; overflow: auto; background: color-mix(in srgb, var(--bg) 38%, var(--gs-2)); border-color: var(--gs-stroke); }

    .channel-skeleton {
      min-height: 260px;
      border: 1px solid var(--gs-stroke);
      border-radius: 19px;
      padding: 20px;
      background: var(--gs-2);
      box-shadow: var(--gs-elev-1);
    }

    .channel-skeleton__line {
      height: 12px;
      margin-bottom: 14px;
      border-radius: var(--radius-full);
      background: linear-gradient(90deg, var(--gs-1), var(--gs-glow-soft), var(--gs-1));
      background-size: 220% 100%;
      animation: channels-shimmer 1.7s ease-in-out infinite;
    }

    .channel-skeleton__line:first-child { width: 44%; height: 44px; }
    .channel-skeleton__line:nth-child(3) { width: 78%; }
    .channel-skeleton__line:nth-child(4) { width: 62%; }

    @keyframes channels-shimmer { from { background-position: 110% 0; } to { background-position: -110% 0; } }
    @keyframes channel-saved-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    @media (max-width: 640px) {
      .channels-page { padding: 0; }
      .channels-hero { grid-template-columns: 1fr; align-items: start; padding: 20px 18px; border-radius: 18px; }
      .channels-hero__aside { justify-content: space-between; }
      .channels-stat { flex: 1; }
      .channels-page .channel-card { padding: 18px; }
      .channels-page .channel-card-header { display: grid; grid-template-columns: auto minmax(0, 1fr); }
      .channels-page .channel-status-pill { grid-column: 1 / -1; justify-self: start; }
      .channels-page .channel-card .status-list { grid-template-columns: 1fr; }
      .channels-page .channel-card .channel-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .channels-page .channel-card .channel-actions .btn { min-width: 0; padding-inline: 8px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .channels-page *,
      .channels-page *::before,
      .channels-page *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
    }

    @media (prefers-reduced-transparency: reduce) {
      .channels-hero,
      .channels-page .channel-card,
      .channels-page .channels-health { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--panel); }
    }
  </style>
`;
