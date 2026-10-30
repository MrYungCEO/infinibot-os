import { appAssetUrl } from "../app-base";
import { html, nothing } from "lit";
import type { UiSettings } from "../storage";
import { icons } from "../icons";
import { getBrandingForPreConnect } from "../controllers/app-branding";

export interface AuthViewState {
  settings: UiSettings;
  password: string;
  showPassword: boolean;
  showAdvanced: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  reconnectAttempt: number;
  error: string | null;
  applySettings: (s: UiSettings) => void;
  onConnect: () => void;
  onPasswordChange: (password: string) => void;
  onTogglePassword: () => void;
  onToggleAdvanced: () => void;
  onGatewayUrlChange: (url: string) => void;

  // ── Multi-user login mode ──
  /** When true, the screen shows username + user-password fields and
   *  resolves the gateway password via POST /api/users/login. */
  loginMode?: boolean;
  username?: string;
  onToggleLoginMode?: () => void;
  onUsernameChange?: (username: string) => void;
  /** Workspace-user 2FA: shown after the server answers totp_required. */
  codeRequired?: boolean;
  code?: string;
  onCodeChange?: (code: string) => void;
}

export function renderAuthScreen(state: AuthViewState) {
  const brand = getBrandingForPreConnect().branding;
  const appName = brand.appName || "InfiniBot";
  const tagline = brand.tagline || "Control Terminal";
  const logoSrc = appAssetUrl(brand.logoDataUrl || brand.logoUrl || "./infinibot-logo.png");
  return html`
    <style>
      ${authStyles}
    </style>
    <div class="auth-container">
      <!-- Animated background -->
      <div class="auth-bg">
        <div class="auth-bg-grid"></div>
        <div class="auth-bg-glow"></div>
        <div class="auth-bg-glow auth-bg-glow--2"></div>
      </div>

      <div class="auth-content">
        <!-- Logo -->
        <div class="auth-logo">
          <img src=${logoSrc} alt=${appName} class="auth-logo-img" />
          <h1 class="auth-title">${appName.toUpperCase()}</h1>
          <p class="auth-subtitle">${tagline.toUpperCase()}</p>
        </div>

        <!-- Auth Card -->
        <div class="auth-card">
          <div class="auth-card-inner">
            ${state.loginMode ? html`
              <div class="auth-field">
                <div class="auth-input-wrapper">
                  <span class="auth-input-icon">${icons.users}</span>
                  <input
                    type="text"
                    class="auth-input"
                    placeholder="Username or email"
                    .value=${state.username ?? ""}
                    @input=${(e: Event) => state.onUsernameChange?.((e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') state.onConnect();
                    }}
                    ?disabled=${state.isConnecting}
                    autofocus
                  />
                </div>
              </div>
            ` : nothing}

            <!-- Password Input -->
            <div class="auth-field">
              <div class="auth-input-wrapper">
                <span class="auth-input-icon">${icons.lock}</span>
                <input
                  type="${state.showPassword ? 'text' : 'password'}"
                  class="auth-input"
                  placeholder="${state.loginMode ? 'Your password' : 'Gateway Password'}"
                  .value=${state.password}
                  @input=${(e: Event) => state.onPasswordChange((e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') state.onConnect();
                  }}
                  ?disabled=${state.isConnecting}
                  ?autofocus=${!state.loginMode}
                />
                <button
                  class="auth-eye-btn"
                  @click=${state.onTogglePassword}
                  type="button"
                  title="${state.showPassword ? 'Hide password' : 'Show password'}"
                >
                  ${state.showPassword ? icons.eyeOff : icons.eye}
                </button>
              </div>
            </div>

            ${state.loginMode && state.codeRequired ? html`
              <div class="auth-field">
                <div class="auth-input-wrapper">
                  <span class="auth-input-icon">${icons.shield}</span>
                  <input
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="6"
                    class="auth-input"
                    placeholder="6-digit code"
                    .value=${state.code ?? ""}
                    @input=${(e: Event) => state.onCodeChange?.((e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') state.onConnect();
                    }}
                    ?disabled=${state.isConnecting}
                    autofocus
                  />
                </div>
              </div>
            ` : nothing}

            ${state.onToggleLoginMode ? html`
              <button
                type="button"
                class="auth-mode-toggle"
                @click=${state.onToggleLoginMode}
              >
                ${state.loginMode ? "Use gateway password instead" : "Sign in as a user account"}
              </button>
            ` : nothing}

            <!-- Advanced Toggle -->
            <button 
              class="auth-advanced-toggle"
              @click=${state.onToggleAdvanced}
              type="button"
            >
              <span>Advanced</span>
              <span class="auth-chevron ${state.showAdvanced ? 'auth-chevron--open' : ''}">${icons.chevronDown}</span>
            </button>

            <!-- Advanced Section -->
            ${state.showAdvanced ? html`
              <div class="auth-advanced">
                <div class="auth-field">
                  <label class="auth-label">Gateway URL</label>
                  <div class="auth-input-wrapper">
                    <span class="auth-input-icon">${icons.server}</span>
                    <input
                      type="text"
                      class="auth-input"
                      placeholder="ws://localhost:18789"
                      .value=${state.settings.gatewayUrl}
                      @input=${(e: Event) => state.onGatewayUrlChange((e.target as HTMLInputElement).value)}
                      ?disabled=${state.isConnecting}
                    />
                  </div>
                </div>
              </div>
            ` : nothing}

            <!-- Error -->
            ${state.error ? html`
              <div class="auth-error">
                <span class="auth-error-icon">${icons.alertCircle}</span>
                <span>${state.error}</span>
              </div>
            ` : nothing}

            <!-- Connect Button -->
            <button
              class="auth-connect-btn ${state.isConnecting || state.isReconnecting ? 'auth-connect-btn--loading' : ''}"
              @click=${state.onConnect}
              ?disabled=${state.isConnecting || !state.password.trim()}
            >
              ${state.isReconnecting ? html`
                <span class="auth-spinner"></span>
                <span>Reconnecting${state.reconnectAttempt > 1 ? ` (${state.reconnectAttempt})` : ''}...</span>
              ` : state.isConnecting ? html`
                <span class="auth-spinner"></span>
                <span>Connecting...</span>
              ` : html`
                <span class="auth-connect-icon">${icons.zap}</span>
                <span>Connect</span>
              `}
            </button>
          </div>
        </div>

        <!-- Footer -->
        <p class="auth-footer">
          <span class="auth-footer-icon">${icons.shield}</span>
          Secure WebSocket Connection
        </p>
      </div>
    </div>
  `;
}

const authStyles = `
  html,
  body {
    margin: 0;
    overflow: clip;
    scrollbar-width: none;
  }

  html::-webkit-scrollbar,
  body::-webkit-scrollbar {
    display: none;
  }

  .auth-container {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--g-bg, #050505);
    background-image: var(--g-gradient-bg, none);
    font-family: var(--g-font-family, var(--font-sans, system-ui, -apple-system, sans-serif));
    color: var(--g-fg, #f5f5f4);
    overflow: clip;
    scrollbar-width: none;
    z-index: 9999;
  }

  .auth-container::-webkit-scrollbar {
    display: none;
  }

  /* Animated Background */
  .auth-bg {
    position: absolute;
    inset: 0;
    overflow: clip;
  }

  .auth-bg-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(var(--g-primary-soft, color-mix(in srgb, var(--g-primary) 2%, transparent)) 1px, transparent 1px),
      linear-gradient(90deg, var(--g-primary-soft, color-mix(in srgb, var(--g-primary) 2%, transparent)) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: auth-grid-move 30s linear infinite;
  }

  @keyframes auth-grid-move {
    0% { transform: translate(0, 0); }
    100% { transform: translate(50px, 50px); }
  }

  .auth-bg-glow {
    position: absolute;
    top: 20%;
    left: 50%;
    width: 600px;
    height: 600px;
    background: radial-gradient(circle, var(--g-primary-muted, color-mix(in srgb, var(--g-primary) 8%, transparent)) 0%, transparent 70%);
    transform: translateX(-50%);
    animation: auth-glow-pulse 4s ease-in-out infinite;
  }
  .auth-bg-glow--2 {
    background: radial-gradient(circle, var(--g-accent-muted, rgba(168, 85, 247, 0.06)) 0%, transparent 70%);
  }

  .auth-bg-glow--2 {
    top: 60%;
    animation-delay: -2s;
    opacity: 0.5;
  }

  @keyframes auth-glow-pulse {
    0%, 100% { opacity: 0.5; transform: translateX(-50%) scale(1); }
    50% { opacity: 0.8; transform: translateX(-50%) scale(1.1); }
  }

  /* Content */
  .auth-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
    width: 100%;
    max-width: 420px;
    overflow: hidden;
    animation: auth-fade-in 0.6s ease-out;
  }

  @keyframes auth-fade-in {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Logo */
  .auth-logo {
    text-align: center;
    margin-bottom: 2.5rem;
  }

  .auth-logo-img {
    width: 80px;
    height: 80px;
    margin-bottom: 1rem;
    filter: drop-shadow(0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent));
    animation: auth-logo-float 3s ease-in-out infinite;
  }

  @keyframes auth-logo-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }

  .auth-title {
    font-size: 2rem;
    font-weight: 800;
    background: var(--g-gradient-accent, linear-gradient(135deg, var(--g-primary), #d97706));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    letter-spacing: 0.15em;
    margin: 0;
    text-shadow: 0 0 30px var(--g-primary-muted, color-mix(in srgb, var(--g-primary) 30%, transparent));
  }

  .auth-subtitle {
    font-size: 0.75rem;
    color: var(--g-fg-dim, #888);
    letter-spacing: 0.25em;
    margin: 0.5rem 0 0 0;
    text-transform: uppercase;
  }

  /* Card */
  .auth-card {
    width: 100%;
    background: var(--g-gradient-surface, rgba(10, 10, 14, 0.7));
    border: 1px solid var(--g-border, color-mix(in srgb, var(--g-primary) 20%, transparent));
    border-radius: max(18px, var(--g-radius-lg, 18px));
    background-clip: padding-box;
    overflow: hidden;
    scrollbar-width: none;
    backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(180%));
    -webkit-backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(180%));
    isolation: isolate;
    box-shadow:
      var(--g-shadow-lg, 0 24px 60px rgba(0, 0, 0, 0.45)),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .auth-card-inner {
    padding: 2rem;
    overflow: hidden;
  }

  /* Fields */
  .auth-field {
    margin-bottom: 1rem;
  }

  .auth-label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted, #888);
    margin-bottom: 0.5rem;
    letter-spacing: 0.05em;
  }

  .auth-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .auth-input-icon {
    position: absolute;
    left: 1rem;
    color: var(--g-primary, var(--g-primary));
    opacity: 0.8;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }

  .auth-input-icon svg {
    width: 18px;
    height: 18px;
  }

  .auth-input {
    width: 100%;
    padding: 1rem 3rem;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--g-border, color-mix(in srgb, var(--g-primary) 15%, transparent));
    border-radius: 10px;
    color: var(--g-fg, #fff);
    font-size: 1rem;
    transition: all 0.2s;
  }

  .auth-input::placeholder {
    color: var(--g-fg-faint, rgba(255, 255, 255, 0.25));
  }

  .auth-input:focus {
    outline: none;
    border-color: var(--g-primary, var(--g-primary));
    background: rgba(0, 0, 0, 0.5);
    box-shadow: 0 0 0 2px var(--g-primary-soft, color-mix(in srgb, var(--g-primary) 10%, transparent));
  }

  .auth-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .auth-eye-btn {
    position: absolute;
    right: 0.75rem;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .auth-eye-btn:hover {
    color: rgba(255, 255, 255, 0.7);
  }

  .auth-eye-btn svg {
    width: 18px;
    height: 18px;
  }

  /* Advanced Toggle */
  .auth-advanced-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.75rem;
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-size: 0.8rem;
    cursor: pointer;
    transition: color 0.2s;
  }

  .auth-advanced-toggle:hover {
    color: var(--text, #fff);
  }

  .auth-mode-toggle {
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: none;
    border: 1px dashed color-mix(in srgb, var(--g-fg, #fff) 16%, transparent);
    border-radius: 6px;
    color: var(--text-muted, #888);
    font-size: 0.78rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .auth-mode-toggle:hover {
    color: var(--text, #fff);
    border-color: color-mix(in srgb, var(--g-fg, #fff) 28%, transparent);
    background: color-mix(in srgb, var(--g-fg, #fff) 4%, transparent);
  }

  .auth-chevron {
    display: flex;
    transition: transform 0.2s;
  }

  .auth-chevron--open {
    transform: rotate(180deg);
  }

  .auth-chevron svg {
    width: 14px;
    height: 14px;
  }

  /* Advanced Section */
  .auth-advanced {
    margin-bottom: 1rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    animation: auth-slide-down 0.2s ease-out;
  }

  @keyframes auth-slide-down {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Error */
  .auth-error {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    background: rgba(244, 67, 54, 0.08);
    border: 1px solid rgba(244, 67, 54, 0.25);
    border-radius: 10px;
    color: #f44336;
    font-size: 0.85rem;
    animation: auth-shake 0.4s ease-out;
  }

  @keyframes auth-shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-5px); }
    40%, 80% { transform: translateX(5px); }
  }

  .auth-error-icon {
    display: flex;
  }

  .auth-error-icon svg {
    width: 16px;
    height: 16px;
  }

  /* Connect Button */
  .auth-connect-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1rem 1.5rem;
    background: linear-gradient(135deg, var(--gold, var(--g-primary)) 0%, #daa520 100%);
    border: 1px solid #c9951d;
    border-radius: 10px;
    color: #000;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 4px 15px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .auth-connect-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px color-mix(in srgb, var(--g-primary) 40%, transparent);
  }

  .auth-connect-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .auth-connect-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .auth-connect-btn--loading {
    pointer-events: none;
  }

  .auth-connect-icon {
    display: flex;
  }

  .auth-connect-icon svg {
    width: 20px;
    height: 20px;
  }

  /* Spinner */
  .auth-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(0, 0, 0, 0.2);
    border-top-color: #000;
    border-radius: 50%;
    animation: auth-spin 0.8s linear infinite;
  }

  @keyframes auth-spin {
    to { transform: rotate(360deg); }
  }

  /* Footer */
  .auth-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1.5rem;
    color: var(--text-muted, #888);
    font-size: 0.75rem;
    letter-spacing: 0.05em;
  }

  .auth-footer-icon {
    display: flex;
    opacity: 0.6;
  }

  .auth-footer-icon svg {
    width: 14px;
    height: 14px;
  }

  /* Responsive */
  @media (max-width: 480px) {
    .auth-content {
      padding: 1rem;
    }

    .auth-card-inner {
      padding: 1.5rem;
    }

    .auth-title {
      font-size: 1.5rem;
    }
  }
`;
