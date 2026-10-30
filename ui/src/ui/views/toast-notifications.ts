/**
 * Toast Notifications System
 * 
 * Provides a toast notification system for the UI.
 * Listens for "show-toast" custom events and renders animated toast messages.
 */

import { html, nothing, type TemplateResult } from "lit";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";

// =============================================================================
// Types
// =============================================================================

export interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  timestamp: number;
  duration: number;
}

// =============================================================================
// State
// =============================================================================

let toasts: Toast[] = [];
let requestUpdate: (() => void) | null = null;
let initialized = false;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the toast system with an update callback
 * @param updateFn - Function to call when toasts change (usually component's requestUpdate)
 */
export function initToastSystem(updateFn: () => void): void {
  requestUpdate = updateFn;
  
  if (initialized) return;
  initialized = true;
  
  window.addEventListener("show-toast", ((e: CustomEvent) => {
    const { message, type, duration } = e.detail;
    addToast(message, type ?? "info", duration ?? 2500);
  }) as EventListener);
}

// =============================================================================
// Toast Management
// =============================================================================

/**
 * Add a new toast notification
 */
export function addToast(
  message: string,
  type: Toast["type"] = "info",
  duration = 2500
): string {
  const toast: Toast = {
    id: generateId(),
    message,
    type,
    timestamp: Date.now(),
    duration
  };
  
  toasts.push(toast);
  requestUpdate?.();
  
  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => {
      removeToast(toast.id);
    }, duration);
  }
  
  return toast.id;
}

/**
 * Remove a toast by ID
 */
export function removeToast(id: string): void {
  const index = toasts.findIndex(t => t.id === id);
  if (index !== -1) {
    toasts.splice(index, 1);
    requestUpdate?.();
  }
}

/**
 * Clear all toasts
 */
export function clearToasts(): void {
  toasts = [];
  requestUpdate?.();
}

/**
 * Get current toasts (for debugging)
 */
export function getToasts(): Toast[] {
  return [...toasts];
}

// =============================================================================
// Rendering
// =============================================================================

const typeStyles: Record<Toast["type"], string> = {
  info: "--toast-accent:var(--glass-info,#3b82f6);",
  success: "--toast-accent:var(--glass-ok,#22c55e);",
  warning: "--toast-accent:var(--glass-warn,#eab308);",
  error: "--toast-accent:var(--glass-danger,#ef4444);",
};

/**
 * Render all active toasts
 */
export function renderToasts(): TemplateResult | typeof nothing {
  if (toasts.length === 0) return nothing;
  ensureCommunicationGlassStyles();
  
  return html`
    <div class="toast-container">
      ${toasts.map(toast => html`
        <div 
          class="toast toast-${toast.type}" 
          style="${typeStyles[toast.type]}"
          @click=${() => removeToast(toast.id)}
          title="Click to dismiss"
          role="status"
        >
          <span class="toast-type-icon" aria-hidden="true">${commIcon(toast.type === "success" ? "check" : toast.type === "info" ? "bell" : "alert", 16)}</span>
          <span class="toast-message">${toast.message}</span>
          <button class="toast-close" @click=${(e: Event) => {
            e.stopPropagation();
            removeToast(toast.id);
          }} aria-label="Dismiss notification">${commIcon("close", 15)}</button>
        </div>
      `)}
    </div>
    
    <style>
      .toast-container {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 100000;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
        max-width: min(400px, calc(100vw - 40px));
      }
      
      .toast {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) 28px;
        align-items: center;
        gap: 10px;
        padding: 12px;
        border-radius: var(--glass-radius, 14px) !important;
        border: 1px solid var(--glass-stroke-strong) !important;
        color: var(--glass-fg, var(--g-fg, #f5f5f4));
        font-size: 14px;
        font-weight: 500;
        box-shadow: var(--glass-elev-4) !important;
        animation: toastSlideIn var(--glass-dur, 180ms) var(--glass-spring, cubic-bezier(0.34, 1.56, 0.64, 1));
        pointer-events: auto;
        cursor: pointer;
        position: relative;
        transition: transform var(--glass-dur, 180ms) var(--glass-spring), opacity var(--glass-dur, 180ms) var(--glass-ease);
      }

      .toast::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        border-radius: var(--glass-radius, 14px) 0 0 var(--glass-radius, 14px);
        background: var(--toast-accent);
        box-shadow: 0 0 16px color-mix(in srgb, var(--toast-accent) 60%, transparent);
      }
      
      .toast:hover {
        transform: var(--glass-lift, translateY(-2px));
        border-color: color-mix(in srgb, var(--toast-accent) 48%, var(--glass-stroke)) !important;
      }

      .toast-type-icon {
        width: 30px;
        height: 30px;
        display: grid;
        place-items: center;
        color: var(--toast-accent);
        background: color-mix(in srgb, var(--toast-accent) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--toast-accent) 30%, transparent);
        border-radius: var(--glass-radius-sm, 10px);
      }
      
      .toast-message {
        word-wrap: break-word;
        overflow-wrap: break-word;
        line-height: 1.4;
      }
      
      .toast-close {
        position: static;
        background: var(--glass-hover) !important;
        border: 1px solid var(--glass-stroke) !important;
        color: var(--glass-fg-3) !important;
        cursor: pointer;
        width: 28px;
        height: 28px;
        border-radius: var(--glass-radius-sm, 10px) !important;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        opacity: 1;
        transition: color var(--glass-dur-fast), border-color var(--glass-dur-fast), transform var(--glass-dur-fast);
      }
      
      .toast-close:hover {
        color: var(--toast-accent) !important;
        border-color: color-mix(in srgb, var(--toast-accent) 48%, var(--glass-stroke)) !important;
        transform: scale(1.04);
      }

      .toast-close:focus-visible { outline: none; box-shadow: var(--glass-focus-ring) !important; }
      
      @keyframes toastSlideIn {
        from {
          transform: translateX(120%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      
      @keyframes toastSlideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(120%);
          opacity: 0;
        }
      }
      
      /* Mobile adjustments */
      @media (max-width: 480px) {
        .toast-container {
          left: 10px;
          right: 10px;
          bottom: 10px;
          max-width: none;
        }
        
        .toast {
          font-size: 13px;
          grid-template-columns: 28px minmax(0, 1fr) 28px;
          padding: 10px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .toast { animation: none; transition: none; }
      }

      @media (prefers-reduced-transparency: reduce) {
        .toast { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: var(--glass-solid) !important; }
      }
    </style>
  `;
}

// =============================================================================
// Helpers
// =============================================================================

function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Show an info toast
 */
export function toastInfo(message: string, duration = 2500): string {
  return addToast(message, "info", duration);
}

/**
 * Show a success toast
 */
export function toastSuccess(message: string, duration = 2500): string {
  return addToast(message, "success", duration);
}

/**
 * Show a warning toast
 */
export function toastWarning(message: string, duration = 3500): string {
  return addToast(message, "warning", duration);
}

/**
 * Show an error toast
 */
export function toastError(message: string, duration = 4000): string {
  return addToast(message, "error", duration);
}
