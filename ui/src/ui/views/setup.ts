/**
 * Setup & Configuration Management View
 * Unified page for MCP setup, Docker config, Setup Wizard, and instance management
 */

import { html, nothing } from "lit";
import { renderSetupGuideButton } from "../setup-guide-video";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  type SetupState,
  type DownloadUrls,
  createSetupState,
  loadSetupStatus,
  getMcpConfigPath,
  generateMcpConfig,
  getDockerSetupScript,
  setActiveSection,
  buildConnectionUrl,
  buildWebConnectionUrl,
  updateDownloadUrls,
  copyConnectionInfo,
  getCliInstallCommand,
  getCliConnectCommand,
} from "../controllers/setup";
import {
  type NetworkState,
  createNetworkState,
  loadNetworkState,
  addInstance,
  removeInstance,
  setActiveInstance,
  checkInstanceStatus,
  showAddInstanceDialog,
  hideAddInstanceDialog,
  updateAddInstanceForm,
} from "../controllers/network";
import { renderNetworkSection } from "./network";
import { renderQuickstart, quickstartStyles } from "./quickstart";
import { renderSetupWizard, getWizardProgress } from "./setup-wizard";
import "./onboarding-flow";
import { onboardingFinished } from "./onboarding-flow";
import { clearProgress, loadProgress, saveProgress } from "../onboarding/profile";
import "./setup-summary";
import { keyed } from "lit/directives/keyed.js";
import {
  ONBOARDING_CLOSE_EVENT,
  SETUP_EDIT_DONE_EVENT,
  paramForStep,
  stepFromParam,
  type EditDoneDetail,
  type EditableStep,
} from "../onboarding/setup-areas";
import { evaluateFirstRun, getFirstRunStatus } from "../controllers/first-run";
import { g8GlassStyles } from "./glass-g8.js";
import { icons, icon } from "../icons";

// ── Styles ────────────────────────────────────────────────────────────────

const setupStyles = html`
<style>
  .setup-page {
    padding: 24px;
    max-width: 1400px;
    margin: 0 auto;
    color: var(--c-text-1, #e4e4e7);
  }
  
  .setup-header {
    margin-bottom: 32px;
    padding: 20px 24px;
    border-radius: 16px;
  }

  @media (max-width: 600px) {
    .setup-header { padding: 16px; }
    .setup-header h1 { font-size: 23px; }
  }
  
  .setup-header h1 {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 8px 0;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .setup-header p {
    color: var(--c-text-2, #a1a1aa);
    margin: 0;
    font-size: 14px;
  }
  
  .setup-grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 24px;
  }
  
  @media (max-width: 900px) {
    .setup-grid {
      grid-template-columns: 1fr;
    }
  }
  
  /* Navigation sidebar */
  .setup-nav {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .setup-nav-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .setup-nav-item:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.1);
  }
  
  .setup-nav-item.active {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .setup-nav-item.active .nav-icon {
    color: var(--g-primary);
  }

  /* Info-box icon — size for SVG */
  .info-box-icon {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    width: 24px;
    min-width: 24px;
    padding-top: 1px;
    flex-shrink: 0;
  }
  .info-box-icon svg {
    width: 20px;
    height: 20px;
  }
  
  .nav-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--c-text-2, #71717a);
    transition: color 0.2s ease;
  }
  .nav-icon svg {
    width: 18px;
    height: 18px;
  }
  
  .nav-info {
    flex: 1;
  }
  
  .nav-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--c-text-1, #e4e4e7);
  }
  
  .nav-desc {
    font-size: 12px;
    color: var(--c-text-2, #71717a);
    margin-top: 2px;
  }
  
  .nav-status {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .nav-status.ok {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }
  
  .nav-status.warning {
    background: rgba(251, 191, 36, 0.15);
    color: var(--g-primary);
  }
  
  .nav-status.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  
  /* Content panel */
  .setup-content {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    overflow: hidden;
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    box-shadow: 0 8px 32px rgba(0,0,0,0.2), 0 1px 0 rgba(255,255,255,0.04) inset;
  }

  .content-header {
    padding: 20px 24px;
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .content-header::after {
    content: '';
    position: absolute;
    bottom: 0; left: 24px; right: 24px;
    height: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 40%, transparent) 0%, transparent 80%);
  }

  .content-header h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .content-header h2 svg {
    width: 20px;
    height: 20px;
    color: var(--g-primary);
  }
  
  .content-body {
    padding: 24px;
  }
  
  /* Cards */
  .setup-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  
  .setup-card {
    background: rgba(255, 255, 255, 0.035);
    backdrop-filter: blur(16px) saturate(160%);
    -webkit-backdrop-filter: blur(16px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 20px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 1px 0 rgba(255,255,255,0.04) inset;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .setup-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: color-mix(in srgb, var(--g-primary) 25%, rgba(255,255,255,0.1));
    transform: translateY(-2px);
    box-shadow: 0 8px 30px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.06) inset;
  }

  .setup-card h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .setup-card h3 svg {
    width: 16px;
    height: 16px;
    color: var(--g-primary);
  }

  .setup-card p {
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    margin: 0 0 16px 0;
    line-height: 1.5;
  }

  /* Icon disc for section accents */
  .icon-disc {
    width: 36px; height: 36px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .icon-disc--accent {
    background: color-mix(in srgb, var(--g-primary) 15%, rgba(255,255,255,0.03));
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
    box-shadow: 0 0 16px color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  .icon-disc svg { width: 18px; height: 18px; }

  /* Wizard hero progress strip */
  .wizard-hero {
    background: linear-gradient(135deg,
      color-mix(in srgb, var(--g-primary) 7%, transparent) 0%,
      rgba(255,255,255,0.02) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255,255,255,0.06));
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 28%, rgba(255,255,255,0.1));
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 24px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.05) inset;
  }
  .wizard-hero__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .wizard-hero__title {
    font-size: 14px; font-weight: 600;
    color: var(--g-primary);
    display: flex; align-items: center; gap: 8px;
  }
  .wizard-hero__title svg { width: 16px; height: 16px; }
  .wizard-hero__meta {
    display: flex; align-items: center; gap: 12px;
  }
  .wizard-hero__pct {
    font-size: 22px; font-weight: 700;
    color: var(--g-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .wiz-stepper {
    display: flex; align-items: flex-start;
    margin: 0 0 20px 0;
  }
  .wiz-stepper__step {
    display: flex; flex-direction: column; align-items: center;
    gap: 8px; min-width: 0; flex: 0 0 auto;
  }
  .wiz-stepper__disc {
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    border: 1.5px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.04);
    font-size: 12px; font-weight: 700;
    color: var(--c-text-2, #71717a);
    font-variant-numeric: tabular-nums;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }
  .wiz-stepper__disc svg { width: 14px; height: 14px; }
  .wiz-stepper__step.is-done .wiz-stepper__disc {
    background: var(--g-primary);
    border-color: var(--g-primary);
    color: #000;
    box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 45%, transparent);
  }
  .wiz-stepper__step.is-active .wiz-stepper__disc {
    border-color: var(--g-primary);
    color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }
  .wiz-stepper__label {
    font-size: 10px; color: var(--c-text-2, #71717a);
    text-align: center; white-space: nowrap;
    text-transform: uppercase; letter-spacing: 0.06em;
    font-weight: 600;
  }
  .wiz-stepper__step.is-done .wiz-stepper__label,
  .wiz-stepper__step.is-active .wiz-stepper__label {
    color: var(--c-text-1, #e4e4e7);
  }
  .wiz-stepper__connector {
    flex: 1; height: 1.5px;
    background: rgba(255,255,255,0.08);
    margin-top: 17px;
    min-width: 12px;
    transition: background 0.2s ease;
  }
  .wiz-stepper__connector.is-done { background: var(--g-primary); }
  .wizard-hero__actions {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  }
  
  /* Code blocks */
  .code-block {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 16px;
    position: relative;
    margin: 16px 0;
  }
  
  .code-block pre {
    margin: 0;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 13px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  
  .code-block .copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 6px 12px;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-radius: 6px;
    color: var(--g-primary);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .code-block .copy-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  
  /* Buttons */
  .btn {
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  
  .btn-primary {
    background: linear-gradient(135deg, var(--g-primary), #FDB931);
    border: none;
    color: #050505;
  }
  
  .btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .btn-secondary {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--c-text-1, #e4e4e7);
  }
  
  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  
  /* Status indicators */
  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  
  .status-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
  }
  
  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #71717a;
  }
  
  .status-dot.ok { background: #22c55e; }
  .status-dot.warning { background: var(--g-primary); }
  .status-dot.error { background: #ef4444; }
  
  .status-label {
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
  }
  
  .status-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--c-text-1, #e4e4e7);
    margin-left: auto;
  }
  
  /* Steps list */
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  .step-item {
    display: flex;
    gap: 16px;
    padding: 16px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  
  .step-number {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    flex-shrink: 0;
  }
  
  .step-content h4 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 4px 0;
  }
  
  .step-content p {
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    margin: 0;
    line-height: 1.5;
  }
  
  /* Info boxes */
  .info-box {
    display: flex;
    gap: 12px;
    padding: 16px;
    background: rgba(59, 130, 246, 0.08);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 10px;
    margin: 16px 0;
  }
  
  .info-box.warning {
    background: rgba(251, 191, 36, 0.08);
    border-color: rgba(251, 191, 36, 0.2);
  }
  
  .info-box.success {
    background: rgba(34, 197, 94, 0.08);
    border-color: rgba(34, 197, 94, 0.2);
  }
  
  /* .info-box-icon sizing is defined above with SVG support */
  
  .info-box-content {
    flex: 1;
  }
  
  .info-box-content strong {
    display: block;
    font-size: 14px;
    margin-bottom: 4px;
  }
  
  .info-box-content p {
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    margin: 0;
    line-height: 1.5;
  }
  
  /* Tool list */
  .tool-list {
    display: grid;
    gap: 8px;
    margin-top: 16px;
  }
  
  .tool-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
  }
  
  .tool-item code {
    font-family: "JetBrains Mono", monospace;
    font-size: 13px;
    color: var(--g-primary);
  }
  
  .tool-item span {
    font-size: 12px;
    color: var(--c-text-2, #71717a);
    margin-left: auto;
  }
  
  /* Loading spinner */
  .loading-spinner {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: var(--c-text-2, #71717a);
  }
  
  .loading-spinner::after {
    content: "";
    width: 24px;
    height: 24px;
    border: 2px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-top-color: var(--g-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 12px;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  /* Install section styles */
  .connection-hero {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 32px;
    padding: 24px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 5%, transparent), color-mix(in srgb, var(--g-primary) 2%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 16px;
    margin-bottom: 32px;
  }
  
  @media (max-width: 768px) {
    .connection-hero {
      grid-template-columns: 1fr;
      text-align: center;
    }
  }
  
  .connection-info h3 {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px 0;
    color: var(--g-primary);
  }
  
  .connection-info p {
    font-size: 14px;
    color: var(--c-text-2, #a1a1aa);
    margin: 0 0 20px 0;
  }
  
  .connection-details {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  
  .connection-field {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
  }
  
  .connection-field label {
    font-size: 12px;
    color: var(--c-text-2, #71717a);
    min-width: 100px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .connection-field code {
    flex: 1;
    font-family: "JetBrains Mono", monospace;
    font-size: 14px;
    color: var(--c-text-1, #e4e4e7);
    word-break: break-all;
  }
  
  .connection-field .copy-btn {
    padding: 6px 10px;
    font-size: 11px;
  }
  
  .qr-code-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  
  .qr-code {
    width: 180px;
    height: 180px;
    background: white;
    border-radius: 12px;
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .qr-code img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  
  .qr-label {
    font-size: 12px;
    color: var(--c-text-2, #71717a);
    text-align: center;
  }
  
  .platforms-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }
  
  .platform-card {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
    padding: 24px;
  }
  
  .platform-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 16px;
  }
  
  .platform-icon {
    font-size: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    color: var(--g-primary);
  }
  .platform-icon svg {
    width: 32px;
    height: 32px;
  }
  
  .platform-name {
    font-size: 18px;
    font-weight: 600;
  }
  
  .platform-desc {
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    margin-bottom: 20px;
    line-height: 1.5;
  }
  
  .download-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  
  .download-link {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    text-decoration: none;
    color: var(--c-text-1, #e4e4e7);
    transition: all 0.2s ease;
  }
  
  .download-link:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .download-link.primary {
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .download-link.primary:hover {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  
  .download-link .link-icon {
    font-size: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }
  .download-link .link-icon svg {
    width: 18px;
    height: 18px;
  }
  
  .download-link .link-text {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
  }
  
  .download-link .link-badge {
    font-size: 11px;
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: var(--c-text-2, #a1a1aa);
  }
  
  .download-link.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  
  .url-editor {
    margin-top: 12px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
  }
  
  .url-editor label {
    display: block;
    font-size: 11px;
    color: var(--c-text-2, #71717a);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .url-editor input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--c-text-1, #e4e4e7);
    font-size: 13px;
    font-family: monospace;
  }
  
  .url-editor input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
  }
  
  .cli-section {
    margin-top: 32px;
  }
  
  .cli-section h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 16px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .cli-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  
  .cli-tab {
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .cli-tab:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  
  .cli-tab.active {
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
  }
</style>
`;

// ── Section Renderers ─────────────────────────────────────────────────────

function renderOverviewSection(
  state: SetupState,
  onSection: (s: SetupState["activeSection"]) => void
) {
  const progress = getWizardProgress();
  return html`
    <div class="content-header">
      <h2>${icons.scrollText} Setup Overview</h2>
      <button class="btn btn-secondary" @click=${() => location.reload()}>
        ${icons.refresh} Refresh
      </button>
    </div>
    <div class="content-body">

      <!-- Wizard Progress Hero -->
      <div class="wizard-hero">
        <div class="wizard-hero__top">
          <div class="wizard-hero__title">
            ${icons.wand} Setup Wizard Progress
          </div>
          <div class="wizard-hero__meta">
            <div class="wizard-hero__pct">${progress.percent}%</div>
          </div>
        </div>
        <div class="wiz-stepper">
          ${progress.steps.map((step, i) => html`
            <div class="wiz-stepper__step ${step.complete ? 'is-done' : step.active ? 'is-active' : ''}">
              <div class="wiz-stepper__disc">
                ${step.complete ? icons.check : step.step}
              </div>
              <div class="wiz-stepper__label">${step.label}</div>
            </div>
            ${i < progress.steps.length - 1 ? html`
              <div class="wiz-stepper__connector ${step.complete ? 'is-done' : ''}"></div>
            ` : nothing}
          `)}
        </div>
        <div class="wizard-hero__actions">
          ${progress.completed
            ? html`<button class="btn btn-secondary" @click=${() => onSection('wizard')}>${icons.refresh} Re-run Wizard</button>`
            : html`<button class="btn btn-primary" @click=${() => onSection('wizard')}>${icons.wand} ${progress.percent > 0 ? 'Resume Wizard' : 'Start Wizard'}</button>`
          }
        </div>
      </div>

      <div class="status-grid">
        <div class="status-item">
          <div class="status-dot ${state.instanceId ? 'ok' : 'warning'}"></div>
          <span class="status-label">Instance</span>
          <span class="status-value">${state.instanceName || "Not configured"}</span>
        </div>
        <div class="status-item">
          <div class="status-dot ${state.mcpEnabled ? 'ok' : 'warning'}"></div>
          <span class="status-label">MCP Servers</span>
          <span class="status-value">${state.mcpServers.length} configured</span>
        </div>
        <div class="status-item">
          <div class="status-dot ${state.dockerAvailable ? (state.dockerStatus === 'running' ? 'ok' : 'warning') : 'error'}"></div>
          <span class="status-label">Docker</span>
          <span class="status-value">${state.dockerAvailable ? state.dockerStatus : "Not available"}</span>
        </div>
        <div class="status-item">
          <div class="status-dot ${state.apiKeysConfigured.length > 0 ? 'ok' : 'warning'}"></div>
          <span class="status-label">API Keys</span>
          <span class="status-value">${state.apiKeysConfigured.length}/${state.apiKeysConfigured.length + state.apiKeysMissing.length}</span>
        </div>
      </div>

      <!-- Quick Connect One-Liner -->
      <div class="quick-connect-box" style="
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 2%, transparent) 100%);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 24px;
      ">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
          <span class="icon-disc icon-disc--accent">${icons.zap}</span>
          <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--g-primary);">Quick Connect</h3>
        </div>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: var(--c-text-2, #a1a1aa);">
          Connect any Infinibot CLI to this gateway with one command:
        </p>
        <div class="code-block" style="position: relative; margin: 0;">
          <pre style="
            background: rgba(0, 0, 0, 0.3);
            padding: 14px 80px 14px 16px;
            border-radius: 8px;
            font-size: 13px;
            overflow-x: auto;
            margin: 0;
            color: #e4e4e7;
          ">${getCliConnectCommand(state)}</pre>
          <button
            class="copy-btn"
            style="
              position: absolute;
              top: 50%;
              right: 12px;
              transform: translateY(-50%);
              background: color-mix(in srgb, var(--g-primary) 10%, transparent);
              border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
              border-radius: 6px;
              padding: 6px 10px;
              font-size: 12px;
              color: var(--g-primary);
              cursor: pointer;
              display: inline-flex;
              align-items: center;
              gap: 4px;
            "
            @click=${(e: MouseEvent) => {
              navigator.clipboard.writeText(getCliConnectCommand(state));
              const btn = e.currentTarget as HTMLButtonElement;
              const label = btn.querySelector('.copy-label') as HTMLElement;
              if (label) { label.textContent = 'Copied!'; setTimeout(() => label.textContent = 'Copy', 1500); }
            }}
          >${icons.copy} <span class="copy-label">Copy</span></button>
        </div>
      </div>

      <div class="setup-cards">
        <div class="setup-card" @click=${() => onSection('wizard')}>
          <h3>${icons.wand} Setup Wizard</h3>
          <p>Run the setup wizard to configure your Infinibot instance with API keys, channels, and preferences.</p>
        </div>

        <div class="setup-card" @click=${() => onSection('mcp')}>
          <h3>${icons.plug} MCP Integration</h3>
          <p>Connect Claude Desktop to your Kanban board and other tools via Model Context Protocol.</p>
        </div>

        <div class="setup-card" @click=${() => onSection('docker')}>
          <h3>${icons.container} Docker Deployment</h3>
          <p>Deploy Infinibot on a server using Docker Compose for always-on operation.</p>
        </div>
      </div>

      ${state.apiKeysMissing.length > 0 ? html`
        <div class="info-box warning">
          <div class="info-box-icon">${icons.alert}</div>
          <div class="info-box-content">
            <strong>Missing API Keys</strong>
            <p>The following providers need API keys: ${state.apiKeysMissing.join(", ")}.
               Configure them in <a href="/apikeys" style="color: var(--g-primary);">API Keys</a>.</p>
          </div>
        </div>
      ` : html`
        <div class="info-box success">
          <div class="info-box-icon">${icons.checkCircle}</div>
          <div class="info-box-content">
            <strong>All API Keys Configured</strong>
            <p>Your essential providers are set up and ready to use.</p>
          </div>
        </div>
      `}
    </div>
  `;
}

function renderMcpSection(state: SetupState) {
  const configJson = generateMcpConfig("path/to/infinibot");
  const mcpPath = getMcpConfigPath();
  
  return html`
    <div class="content-header" data-learn-id="setup-mcp-header">
      <h2>${icons.plug} MCP Integration</h2>
    </div>
    <div class="content-body">
      <p style="color: var(--c-text-2); margin-bottom: 24px;">
        Connect <strong>Claude Desktop</strong> to your Infinibot tools using the Model Context Protocol (MCP).
        This enables Claude to directly interact with your Kanban board, files, memory, and more.
      </p>
      
      <div class="steps-list">
        <div class="step-item">
          <div class="step-number">1</div>
          <div class="step-content">
            <h4>Locate Config File</h4>
            <p>Open or create the config file at:<br>
            <code style="color: var(--g-primary);">${mcpPath}</code></p>
          </div>
        </div>
        
        <div class="step-item">
          <div class="step-number">2</div>
          <div class="step-content">
            <h4>Add MCP Configuration</h4>
            <p>Copy and paste the following configuration. Update the path to your Infinibot installation.</p>
          </div>
        </div>
      </div>
      
      <div class="code-block">
        <pre>${configJson}</pre>
        <button class="copy-btn" @click=${() => navigator.clipboard.writeText(configJson)} style="display:inline-flex;align-items:center;gap:4px;">
          ${icons.copy} Copy
        </button>
      </div>

      <div class="step-item">
        <div class="step-number">3</div>
        <div class="step-content">
          <h4>Restart Claude Desktop</h4>
          <p>After saving the config file, restart Claude Desktop to load the MCP servers.</p>
        </div>
      </div>
      
      <h3 style="margin-top: 32px; margin-bottom: 16px;">Available MCP Tools</h3>
      <div class="tool-list">
        <div class="tool-item">
          <code>kanban_list_projects</code>
          <span>List all kanban projects</span>
        </div>
        <div class="tool-item">
          <code>kanban_create_project</code>
          <span>Create new project</span>
        </div>
        <div class="tool-item">
          <code>kanban_list_tasks</code>
          <span>List tasks by project or status</span>
        </div>
        <div class="tool-item">
          <code>kanban_create_task</code>
          <span>Create new task</span>
        </div>
        <div class="tool-item">
          <code>kanban_update_task</code>
          <span>Update task status/details</span>
        </div>
        <div class="tool-item">
          <code>memory_search</code>
          <span>Search agent memory</span>
        </div>
        <div class="tool-item">
          <code>file_read</code>
          <span>Read workspace files</span>
        </div>
        <div class="tool-item">
          <code>file_write</code>
          <span>Write workspace files</span>
        </div>
      </div>
    </div>
  `;
}

function renderDockerSection(state: SetupState) {
  const dockerScript = getDockerSetupScript();
  
  return html`
    <div class="content-header">
      <h2>${icons.container} Docker Deployment</h2>
    </div>
    <div class="content-body">
      <p style="color: var(--c-text-2); margin-bottom: 24px;">
        Deploy Infinibot on a Linux server using Docker Compose for always-on operation.
        Perfect for running agents 24/7 with all channels connected.
      </p>
      
      ${state.dockerAvailable ? html`
        <div class="info-box success">
          <div class="info-box-icon">${icons.container}</div>
          <div class="info-box-content">
            <strong>Docker Detected</strong>
            <p>Status: ${state.dockerStatus} | Containers: ${state.dockerContainers.length}</p>
          </div>
        </div>
      ` : nothing}
      
      <h3 style="margin-bottom: 16px;">Quick Start Script</h3>
      <div class="code-block">
        <pre>${dockerScript}</pre>
        <button class="copy-btn" @click=${() => navigator.clipboard.writeText(dockerScript)} style="display:inline-flex;align-items:center;gap:4px;">
          ${icons.copy} Copy
        </button>
      </div>
      
      <div class="steps-list" style="margin-top: 24px;">
        <div class="step-item">
          <div class="step-number">1</div>
          <div class="step-content">
            <h4>Prerequisites</h4>
            <p>Ensure Docker and Docker Compose are installed on your server.</p>
          </div>
        </div>
        
        <div class="step-item">
          <div class="step-number">2</div>
          <div class="step-content">
            <h4>Run Setup Script</h4>
            <p>Clone the repository and run <code style="color: var(--g-primary);">./docker-setup.sh</code></p>
          </div>
        </div>
        
        <div class="step-item">
          <div class="step-number">3</div>
          <div class="step-content">
            <h4>Complete Onboarding</h4>
            <p>Follow the interactive prompts to configure gateway auth and providers.</p>
          </div>
        </div>
        
        <div class="step-item">
          <div class="step-number">4</div>
          <div class="step-content">
            <h4>Connect Channels</h4>
            <p>Add Telegram, Discord, WhatsApp tokens via the CLI or web UI.</p>
          </div>
        </div>
      </div>
      
      <h3 style="margin-top: 32px; margin-bottom: 16px;">Environment Variables</h3>
      <div class="tool-list">
        <div class="tool-item">
          <code>INFINIBOT_CONFIG_DIR</code>
          <span>~/.infinibot</span>
        </div>
        <div class="tool-item">
          <code>INFINIBOT_WORKSPACE_DIR</code>
          <span>~/infinibot</span>
        </div>
        <div class="tool-item">
          <code>INFINIBOT_GATEWAY_PORT</code>
          <span>18789</span>
        </div>
        <div class="tool-item">
          <code>INFINIBOT_GATEWAY_BIND</code>
          <span>lan</span>
        </div>
      </div>
    </div>
  `;
}

function renderWizardSection(state: SetupState) {
  const progress = getWizardProgress();
  const stepIcons = [icons.house, icons.key, icons.messageSquare, icons.plug, icons.checkCircle];
  return html`
    <div class="content-header">
      <h2>${icons.wand} Setup Wizard</h2>
      ${state.wizardCompleted ? html`
        <span class="nav-status ok">Completed</span>
      ` : html`
        <span class="nav-status warning">Incomplete</span>
      `}
    </div>
    <div class="content-body">
      <p style="color: var(--c-text-2); margin-bottom: 24px;">
        The setup wizard guides you through initial configuration — model provider, channels, integrations, and a final smoke test.
      </p>

      <div class="setup-cards">
        ${progress.steps.map((step, i) => html`
          <div class="setup-card" style="${step.complete ? 'border-color: color-mix(in srgb, #22c55e 25%, transparent);' : step.active ? 'border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);' : ''}">
            <h3 style="color: ${step.complete ? '#22c55e' : step.active ? 'var(--g-primary)' : 'var(--c-text-1)'};">
              ${step.complete ? icons.checkCircle : stepIcons[i]}
              ${step.label}
            </h3>
            <p style="font-size: 12px; color: #71717a; margin: 0;">Step ${step.step} of 5 ${step.optional ? '· optional' : ''}</p>
            <p style="font-size: 12px; margin: 8px 0 0; color: ${step.complete ? '#22c55e' : step.active ? 'var(--g-primary)' : 'var(--c-text-2)'};">
              ${step.complete ? 'Done' : step.active ? 'Current step' : 'Pending'}
            </p>
          </div>
        `)}
      </div>

      <div style="margin-top: 24px; display: flex; gap: 12px;">
        ${progress.completed
          ? html`<button class="btn btn-secondary">${icons.refresh} Re-run Wizard</button>`
          : html`<button class="btn btn-primary">${icons.wand} ${progress.percent > 0 ? 'Resume Wizard' : 'Start Wizard'}</button>`
        }
        <a href="/config" class="btn btn-secondary" style="display:inline-flex;align-items:center;gap:8px;">
          ${icons.settings} Manual Config
        </a>
      </div>
    </div>
  `;
}

function renderInstanceSection(state: SetupState) {
  return html`
    <div class="content-header">
      <h2>${icons.house} Instance Configuration</h2>
    </div>
    <div class="content-body">
      <div class="status-grid">
        <div class="status-item">
          <div class="status-dot ${state.instanceId ? 'ok' : 'warning'}"></div>
          <span class="status-label">Instance ID</span>
          <span class="status-value">${state.instanceId || "Not set"}</span>
        </div>
        <div class="status-item">
          <div class="status-dot ok"></div>
          <span class="status-label">Name</span>
          <span class="status-value">${state.instanceName || "Unnamed"}</span>
        </div>
        <div class="status-item">
          <div class="status-dot ok"></div>
          <span class="status-label">Role</span>
          <span class="status-value" style="display:inline-flex;align-items:center;gap:6px;">${state.instanceRole === 'primary' ? html`${icons.crown} Primary` : state.instanceRole === 'secondary' ? html`${icons.link} Secondary` : 'Unknown'}</span>
        </div>
      </div>
      
      <div class="info-box">
        <div class="info-box-icon">${icons.alertCircle}</div>
        <div class="info-box-content">
          <strong>Multi-Instance Support</strong>
          <p>Infinibot supports running multiple instances that sync memory and state.
             The primary instance holds the canonical state, while secondaries sync to it.</p>
        </div>
      </div>
      
      <h3 style="margin-top: 24px; margin-bottom: 16px;">Configured Providers</h3>
      <div class="tool-list">
        ${state.apiKeysConfigured.map(provider => html`
          <div class="tool-item">
            <div class="status-dot ok"></div>
            <code>${provider}</code>
            <span style="display:inline-flex;align-items:center;gap:4px;">${icons.check} Configured</span>
          </div>
        `)}
        ${state.apiKeysMissing.map(provider => html`
          <div class="tool-item">
            <div class="status-dot warning"></div>
            <code>${provider}</code>
            <span>Not configured</span>
          </div>
        `)}
      </div>
      
      <div style="margin-top: 24px;">
        <a href="/apikeys" class="btn btn-secondary">
          ${icons.key} Manage API Keys
        </a>
      </div>
    </div>
  `;
}

function renderInstallSection(
  state: SetupState,
  client: GatewayBrowserClient,
  onUpdate: () => void
) {
  const connectionUrl = buildConnectionUrl(
    state.gatewayUrl || gatewayOrigin(),
    state.gatewayToken,
    state.instanceName
  );
  
  const webUrl = buildWebConnectionUrl(
    state.gatewayUrl || gatewayOrigin(),
    state.gatewayToken
  );
  
  // State for CLI platform tab
  let cliPlatform: "windows" | "linux" | "mac" = "windows";
  if (navigator.platform.toLowerCase().includes("mac")) cliPlatform = "mac";
  else if (navigator.platform.toLowerCase().includes("linux")) cliPlatform = "linux";
  
  const handleUrlChange = async (platform: keyof DownloadUrls, value: string) => {
    const urls: Partial<DownloadUrls> = { [platform]: value || null };
    await updateDownloadUrls(client, urls, (update) => {
      Object.assign(state, update);
      onUpdate();
    });
  };
  
  return html`
    <div class="content-header">
      <h2>${icons.smartphone} Install & Connect Devices</h2>
      <button class="btn btn-secondary" @click=${() => copyConnectionInfo("full", state)} style="display:inline-flex;align-items:center;gap:6px;">
        ${icons.copy} Copy All
      </button>
    </div>
    <div class="content-body">
      <!-- Connection Hero -->
      <div class="connection-hero" data-learn-id="setup-connect-hero">
        <div class="connection-info">
          <h3 style="display:flex;align-items:center;gap:8px;">${icons.flame} ${state.instanceName || "Infinibot Instance"}</h3>
          <p>Connect your devices to this instance using the QR code or connection details below.</p>
          
          <div class="connection-details">
            <div class="connection-field">
              <label>Gateway</label>
              <code>${state.gatewayUrl || "Not configured"}</code>
              <button class="copy-btn" @click=${() => navigator.clipboard.writeText(state.gatewayUrl || "")} style="display:inline-flex;align-items:center;">
                ${icons.copy}
              </button>
            </div>
            <div class="connection-field">
              <label>Token</label>
              <code>${state.gatewayToken ? "••••••••" + state.gatewayToken.slice(-8) : "Not set"}</code>
              <button class="copy-btn" @click=${() => navigator.clipboard.writeText(state.gatewayToken || "")} style="display:inline-flex;align-items:center;">
                ${icons.copy}
              </button>
            </div>
            <div class="connection-field">
              <label>Code</label>
              <code style="font-size: 18px; font-weight: 700; color: var(--g-primary); letter-spacing: 2px;">
                ${state.connectionCode || "---"}
              </code>
              <button class="copy-btn" @click=${() => navigator.clipboard.writeText(state.connectionCode || "")} style="display:inline-flex;align-items:center;">
                ${icons.copy}
              </button>
            </div>
          </div>
        </div>
        
        <div class="qr-code-container">
          ${state.connectionQrDataUrl ? html`
            <div class="qr-code">
              <img src="${state.connectionQrDataUrl}" alt="Connection QR Code" />
            </div>
            <div class="qr-label">Scan to connect</div>
          ` : html`
            <div class="qr-code" style="background: rgba(0,0,0,0.3); color: #71717a; font-size: 12px;">
              QR code loading...
            </div>
          `}
        </div>
      </div>
      
      <!-- Platform Downloads -->
      <h3 style="margin-bottom: 20px; display:flex; align-items:center; gap:8px;">${icons.download} Download Apps</h3>
      <div class="platforms-grid">
        <!-- Android -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.smartphone}</span>
            <span class="platform-name">Android</span>
          </div>
          <p class="platform-desc">
            Install the Infinibot app on your Android phone or tablet for mobile access to your AI assistant.
          </p>
          <div class="download-options">
            <a href="${state.downloadUrls.androidApk || '#'}"
               class="download-link ${state.downloadUrls.androidApk ? 'primary' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">Download APK</span>
              ${state.downloadUrls.androidApk ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
          </div>
          <div class="url-editor">
            <label>APK Download URL</label>
            <input type="url" 
                   placeholder="https://example.com/infinibot.apk"
                   .value="${state.downloadUrls.androidApk || ""}"
                   @change=${(e: Event) => handleUrlChange("androidApk", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        
        <!-- iOS -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.smartphone}</span>
            <span class="platform-name">iOS</span>
          </div>
          <p class="platform-desc">
            Get the Infinibot app on your iPhone or iPad via TestFlight for beta access.
          </p>
          <div class="download-options">
            <a href="${state.downloadUrls.iosTestFlight || '#'}"
               class="download-link ${state.downloadUrls.iosTestFlight ? 'primary' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.externalLink}</span>
              <span class="link-text">TestFlight</span>
              ${state.downloadUrls.iosTestFlight ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
          </div>
          <div class="url-editor">
            <label>TestFlight URL</label>
            <input type="url" 
                   placeholder="https://testflight.apple.com/join/..."
                   .value="${state.downloadUrls.iosTestFlight || ""}"
                   @change=${(e: Event) => handleUrlChange("iosTestFlight", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        
        <!-- Windows -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.monitor}</span>
            <span class="platform-name">Windows</span>
          </div>
          <p class="platform-desc">
            Desktop app for Windows with native notifications, system tray, and quick access.
          </p>
          <div class="download-options">
            <a href="${state.downloadUrls.windowsExe || '#'}"
               class="download-link ${state.downloadUrls.windowsExe ? 'primary' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">Download EXE</span>
              ${state.downloadUrls.windowsExe ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
            <a href="${state.downloadUrls.windowsMsi || '#'}"
               class="download-link ${state.downloadUrls.windowsMsi ? '' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">MSI Installer</span>
              ${state.downloadUrls.windowsMsi ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
          </div>
          <div class="url-editor">
            <label>EXE Download URL</label>
            <input type="url" 
                   placeholder="https://example.com/infinibot-setup.exe"
                   .value="${state.downloadUrls.windowsExe || ""}"
                   @change=${(e: Event) => handleUrlChange("windowsExe", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        
        <!-- Linux -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.server}</span>
            <span class="platform-name">Linux</span>
          </div>
          <p class="platform-desc">
            Native Linux app available as AppImage or Debian package.
          </p>
          <div class="download-options">
            <a href="${state.downloadUrls.linuxAppImage || '#'}"
               class="download-link ${state.downloadUrls.linuxAppImage ? 'primary' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">AppImage</span>
              ${state.downloadUrls.linuxAppImage ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
            <a href="${state.downloadUrls.linuxDeb || '#'}"
               class="download-link ${state.downloadUrls.linuxDeb ? '' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">.deb Package</span>
              ${state.downloadUrls.linuxDeb ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
          </div>
          <div class="url-editor">
            <label>AppImage URL</label>
            <input type="url" 
                   placeholder="https://example.com/infinibot.AppImage"
                   .value="${state.downloadUrls.linuxAppImage || ""}"
                   @change=${(e: Event) => handleUrlChange("linuxAppImage", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        
        <!-- macOS -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.monitor}</span>
            <span class="platform-name">macOS</span>
          </div>
          <p class="platform-desc">
            Native macOS app with menu bar integration and notification support.
          </p>
          <div class="download-options">
            <a href="${state.downloadUrls.macDmg || '#'}"
               class="download-link ${state.downloadUrls.macDmg ? 'primary' : 'disabled'}"
               target="_blank">
              <span class="link-icon">${icons.download}</span>
              <span class="link-text">Download DMG</span>
              ${state.downloadUrls.macDmg ? nothing : html`<span class="link-badge">Not configured</span>`}
            </a>
          </div>
          <div class="url-editor">
            <label>DMG Download URL</label>
            <input type="url" 
                   placeholder="https://example.com/infinibot.dmg"
                   .value="${state.downloadUrls.macDmg || ""}"
                   @change=${(e: Event) => handleUrlChange("macDmg", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        
        <!-- Web -->
        <div class="platform-card">
          <div class="platform-header">
            <span class="platform-icon">${icons.globe}</span>
            <span class="platform-name">Web App</span>
          </div>
          <p class="platform-desc">
            Access directly from any browser — no installation required.
          </p>
          <div class="download-options">
            <a href="${webUrl}" class="download-link primary" target="_blank">
              <span class="link-icon">${icons.externalLink}</span>
              <span class="link-text">Open Web App</span>
            </a>
            <button class="download-link" @click=${() => navigator.clipboard.writeText(webUrl)}>
              <span class="link-icon">${icons.copy}</span>
              <span class="link-text">Copy Web URL</span>
            </button>
          </div>
        </div>
      </div>
      
      <!-- CLI Installation -->
      <div class="cli-section">
        <h3 style="display:flex;align-items:center;gap:8px;">${icons.terminal} Command Line Installation</h3>
        <p style="color: var(--c-text-2); margin-bottom: 16px;">
          Install the Infinibot CLI for terminal access and automation.
        </p>
        
        <div class="code-block">
          <pre>${getCliInstallCommand(cliPlatform)}</pre>
          <button class="copy-btn" @click=${() => navigator.clipboard.writeText(getCliInstallCommand(cliPlatform))} style="display:inline-flex;align-items:center;gap:4px;">
            ${icons.copy} Copy
          </button>
        </div>

        <h4 style="margin-top: 24px; margin-bottom: 12px;">Connect CLI to this instance:</h4>
        <div class="code-block">
          <pre>${getCliConnectCommand(state)}</pre>
          <button class="copy-btn" @click=${() => navigator.clipboard.writeText(getCliConnectCommand(state))} style="display:inline-flex;align-items:center;gap:4px;">
            ${icons.copy} Copy
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Coding Backend Section — COORDINATION: opencode-swap ─────────────────
// State and rendering are handled by the dedicated toggle component.

import { renderCoderBackendToggle } from "../components/coder-backend-toggle.js";
import { gatewayOrigin } from "../gateway-endpoint";
// Setup › Voice: "Set up voice for me" (one-click local voice, the default —
// same element as the onboarding Voice step) plus the optional, free Cloud voice (Robovoice).
import "../components/robovoice-link.js";
import "../components/local-voice-setup.js";
import { isTabAvailable } from "../plugin-host.js";

function renderVoiceSetupSection(state: AppViewState) {
  const on = isTabAvailable("robovoice");
  const eyebrow = "font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;";
  return html`
    <div class="content-header"><h2>${icons.mic ?? icons.zap} Voice</h2></div>
    <div class="content-body" style="display:grid;gap:18px;max-width:860px;" data-testid="setup-voice">
      <div style="display:grid;gap:8px;" data-testid="setup-voice-local">
        <div style=${eyebrow}>Local voice · the default · private and free</div>
        <ib-local-voice-setup .client=${state.client} context="settings"></ib-local-voice-setup>
      </div>
      <div data-testid="setup-voice-robovoice" style="border:1px solid var(--border);border-radius:14px;padding:18px 20px;background:var(--card);display:grid;gap:12px;">
        <div style=${eyebrow}>Cloud voice (Robovoice) · optional · free</div>
        <div style="font-size:16px;font-weight:650;color:var(--text-strong);">Studio voices and phone calls</div>
        <div style="color:var(--muted);line-height:1.55;">
          Optional, and free. Pick it if this computer can't run voice, or for phone calls and voices on any device. Link this install once on the Voice page. You can switch back to local voice any time.
        </div>
        ${on ? html`<robovoice-link variant="compact"></robovoice-link>` : html`<div style="color:var(--warn);">Cloud voice (Robovoice) is off. You can turn it on from the Voice page if you want it.</div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn primary" data-testid="setup-voice-open" @click=${() => state.setTab("voice")}>Open the Voice page</button>
          <a class="btn" href="https://robovoice.io" target="_blank" rel="noopener">What is Robovoice? ↗</a>
        </div>
      </div>
    </div>`;
}

// Setup › Remote access — the same Tailscale link + phone setup as the
// onboarding Phone step, so it can be done (or turned off) later.
import "../components/remote-access-setup.js";
import "../components/phone-app-setup.js";

let _remoteLink: { url: string | null; verified: boolean } = { url: null, verified: false };

function renderRemoteAccessSection(state: AppViewState) {
  return html`
    <div class="content-header"><h2>${icons.globe} Remote access</h2></div>
    <div class="content-body" style="display:grid;gap:16px;max-width:860px;" data-testid="setup-remote">
      <ib-remote-access-setup
        context="settings"
        .client=${state.client}
        @remote-link=${(e: CustomEvent<{ url: string | null; verified: boolean }>) => {
          _remoteLink = e.detail;
          state.requestUpdate?.();
        }}
      ></ib-remote-access-setup>
      <ib-phone-app-setup context="settings" .client=${state.client} .remoteUrl=${_remoteLink.url} .remoteVerified=${_remoteLink.verified}></ib-phone-app-setup>
    </div>`;
}

// Setup › Components (the folded /components page) — its element registers on first use.
const loadComponentsSettings = () => void import("./components-settings");
// Setup › Coders (install / sign in CLI coding agents) — lazy like Components.
const loadCodersSettings = () => void import("./coders-settings");
// Setup › Connect KinglyVault (kinglyvault-relay plugin pairing) — lazy too.
const loadKvConnectSettings = () => void import("./kv-connect-settings");

// Module-level pending section for pill → setup navigation
let _pendingSetupSection: string | null = null;

// Install the event listener once (outside render to avoid stacking)
if (typeof window !== "undefined") {
  window.addEventListener("infinibot:setup-section", (ev: Event) => {
    _pendingSetupSection = (ev as CustomEvent<{ section: string }>).detail?.section ?? null;
  });
}

/**
 * Setup › Get started: the full-screen onboarding flow until it's finished,
 * then Setup › Your setup: a card per area with Edit (just that step).
 */
let _rerunOnboarding = false;
/** Get started was asked for (nav click, deep link, checklist), not just the default section. */
let _wizardExplicit = false;
/** Setup › Your setup › Edit: the one step open in the flow (null = the summary). */
let _editStep: EditableStep | null = null;
/** What the last edit did, shown once on the summary. */
let _editFlash: { ok: boolean; text: string } | null = null;
/** The `?step=` deep link already handled for this URL. */
let _handledStepSearch: string | null = null;

function setStepParam(step: EditableStep | null) {
  try {
    const url = new URL(window.location.href);
    if (step) url.searchParams.set("step", paramForStep(step));
    else url.searchParams.delete("step");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.toString());
    _handledStepSearch = url.search;
  } catch {
    /* no location (tests) */
  }
}

if (typeof window !== "undefined") {
  // A flow button routes elsewhere: stop showing the full-screen flow first.
  window.addEventListener(ONBOARDING_CLOSE_EVENT, () => {
    _rerunOnboarding = false;
    if (_editStep) setStepParam(null);
    _editStep = null;
  });
  window.addEventListener(SETUP_EDIT_DONE_EVENT, (ev: Event) => {
    const d = (ev as CustomEvent<EditDoneDetail>).detail;
    _editStep = null;
    _editFlash = d?.saved && d.message ? { ok: true, text: d.message } : null;
    setStepParam(null);
  });
}

/**
 * /setup?step=voice: finished installs open just that step to edit; mid-setup
 * installs resume the full flow on it (answers and progress kept).
 */
function applyStepDeepLink(state: AppViewState): boolean {
  if (typeof window === "undefined") return false;
  const search = window.location.search;
  if (search === _handledStepSearch) return false;
  _handledStepSearch = search;
  const step = stepFromParam(new URLSearchParams(search).get("step"));
  if (!step || !state.setupState) return false;
  _wizardExplicit = true;
  if (onboardingFinished()) {
    _rerunOnboarding = false;
    _editStep = step;
    setStepParam(step);
  } else {
    const p = loadProgress();
    saveProgress({ step, done: p?.done ?? [], skipped: p?.skipped ?? [], finishedAt: p?.finishedAt ?? null });
    setStepParam(null);
  }
  state.setupState = { ...state.setupState, activeSection: "wizard" };
  return true;
}

function renderOnboardingSection(state: AppViewState, client: GatewayBrowserClient): ReturnType<typeof html> {
  if (!onboardingFinished() || _rerunOnboarding) {
    // Sticky for this page session: the flow keeps its "done" screen after Finish.
    _rerunOnboarding = true;
    return html`<ib-onboarding-flow .client=${client} .host=${state}></ib-onboarding-flow>`;
  }
  const flash = _editFlash;
  return html`
    <div class="content-header">
      <h2 tabindex="-1" data-testid="setup-summary-title">${icons.checkCircle} Your setup</h2>
    </div>
    <div class="content-body" style="display:grid;gap:18px;">
      <p style="margin:0;color:var(--c-text-2);max-width:760px;">
        Change any one setting here without running the whole setup again. Edit opens just that step with your
        current settings filled in.
      </p>
      <ib-setup-summary
        .client=${client}
        .flash=${flash}
        @setup-edit=${(e: CustomEvent<{ step: EditableStep }>) => {
          _editFlash = null;
          _editStep = e.detail.step;
          setStepParam(e.detail.step);
          state.requestUpdate?.();
        }}
      ></ib-setup-summary>
      <div class="setup-card" data-testid="onboarding-complete-card">
        <p style="margin:0 0 14px;color:var(--c-text-2);">
          Want to go through every step again? Your answers stay filled in and nothing is reset. The advanced wizard
          covers federation, coding agents and integrations.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary" data-testid="onboarding-rerun" @click=${() => {
            clearProgress();
            _rerunOnboarding = true;
            state.requestUpdate?.();
          }}>${icons.wand} Run setup again</button>
          <button class="btn btn-secondary" @click=${() => {
            window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "wizard-advanced" } }));
            state.requestUpdate?.();
          }}>${icons.sliders} Advanced wizard</button>
        </div>
      </div>
    </div>
  `;
}

function renderCoderBackendSection(
  state: AppViewState,
  client: GatewayBrowserClient,
): ReturnType<typeof html> {
  return html`
    <div class="content-body">
      ${renderCoderBackendToggle(state, client)}
    </div>
  `;
}

// ── Main Render ───────────────────────────────────────────────────────────

export function renderSetup(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  // ?onbCliDemo=<state>: the onboarding brain step with fake data (visual checks, no RPCs).
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("onbCliDemo")) {
    return html`<ib-onboarding-flow .client=${client} .host=${state}></ib-onboarding-flow>`;
  }
  // Initialize setup state if needed
  if (!state.setupState) {
    state.setupState = createSetupState();
    // Established installs that never started guided setup open on the
    // overview; new installs (and anyone mid-setup) open on Get started.
    if (getFirstRunStatus() === "established" && !loadProgress()) {
      state.setupState = { ...state.setupState, activeSection: "overview" };
    } else if (!getFirstRunStatus() && !loadProgress()) {
      // Not decided in this browser yet (first visit lands here, not on the
      // dashboard): run the same new-install check, then settle the section.
      void evaluateFirstRun(client, () => {
        if (getFirstRunStatus() === "established" && !_wizardExplicit && state.setupState?.activeSection === "wizard") {
          state.setupState = { ...state.setupState, activeSection: "overview" };
        }
        state.requestUpdate?.();
      });
    }
    loadSetupStatus(client, (update) => {
      state.setupState = { ...state.setupState!, ...update };
      state.requestUpdate?.();
    });
  }
  
  // Initialize network state if needed
  if (!state.networkState) {
    state.networkState = createNetworkState();
    loadNetworkState((update) => {
      state.networkState = { ...state.networkState!, ...update };
      state.requestUpdate?.();
    });
  }
  
  const setupState = state.setupState;
  const networkState = state.networkState;
  
  const handleSectionChange = (section: SetupState["activeSection"]) => {
    setActiveSection((update) => {
      state.setupState = { ...state.setupState!, ...update };
      state.requestUpdate?.();
    }, section);
  };

  // /components folds into Setup › Components: the route arrives as the
  // routing-only host sub-view "components". Apply it once, then normalise the
  // route back to plain /setup so picking another section isn't overridden.
  const route = state as { hostView?: Partial<Record<string, string>> };
  const folded = route.hostView?.setup;
  if ((folded === "components" || folded === "coders" || folded === "kinglyvault") && state.setupState) {
    route.hostView = { ...route.hostView, setup: "setup" };
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url.toString());
    handleSectionChange(folded);
  }

  applyStepDeepLink(state);

  // Apply any pending section from pill navigation
  if (_pendingSetupSection && state.setupState) {
    const pending = _pendingSetupSection as SetupState["activeSection"];
    if (pending === "wizard") _wizardExplicit = true;
    _pendingSetupSection = null;
    handleSectionChange(pending);
  }

  // Guided onboarding is a full-screen console: render it outside the Setup
  // shell (whose backdrop-filter would trap its position:fixed screen).
  const activeSection = state.setupState?.activeSection ?? setupState.activeSection;
  if (activeSection !== "wizard" && _editStep) {
    _editStep = null;
    setStepParam(null);
  }
  if (activeSection === "wizard" && !setupState.loading && _editStep && onboardingFinished() && !_rerunOnboarding) {
    return html`${keyed(_editStep, html`<ib-onboarding-flow .client=${client} .host=${state} .editStep=${_editStep}></ib-onboarding-flow>`)}`;
  }
  if (activeSection === "wizard" && !setupState.loading && (!onboardingFinished() || _rerunOnboarding)) {
    return renderOnboardingSection(state, client);
  }

  return html`
    ${setupStyles}
    ${quickstartStyles}
    ${g8GlassStyles}
    <div class="setup-page g8-page">
      <div class="setup-header">
        <h1 style="display:flex;align-items:center;gap:12px;">${icons.flame} Infinibot Setup</h1>
        <p>Install, connect channels, and configure your AI assistant network</p>
        <div class="setup-header__guide" style="margin-top:12px">${renderSetupGuideButton()}</div>
      </div>
      
      ${setupState.loading ? html`
        <div class="loading-spinner">Loading setup status...</div>
      ` : html`
        <div class="setup-grid">
          <div class="setup-nav">
            <div 
              class="setup-nav-item ${setupState.activeSection === 'quickstart' ? 'active' : ''}"
              data-ib-target="section:setup/quickstart"
              @click=${() => handleSectionChange('quickstart')}
              style="background: ${setupState.activeSection === 'quickstart' ? 'color-mix(in srgb, var(--g-primary) 8%, transparent)' : 'linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 5%, transparent), transparent)'}; border-color: ${setupState.activeSection === 'quickstart' ? 'color-mix(in srgb, var(--g-primary) 30%, transparent)' : 'color-mix(in srgb, var(--g-primary) 15%, transparent)'};"
            >
              <span class="nav-icon">${icons.rocket}</span>
              <div class="nav-info">
                <div class="nav-title" style="color: var(--g-primary);">Quick Start</div>
                <div class="nav-desc">Install & connect</div>
              </div>
              <span class="nav-status ok">New</span>
            </div>
            
            <div 
              class="setup-nav-item ${setupState.activeSection === 'overview' ? 'active' : ''}"
              data-ib-target="section:setup/overview"
              @click=${() => handleSectionChange('overview')}
            >
              <span class="nav-icon">${icons.scrollText}</span>
              <div class="nav-info">
                <div class="nav-title">Overview</div>
                <div class="nav-desc">Status summary</div>
              </div>
            </div>
            
            <div 
              class="setup-nav-item ${setupState.activeSection === 'mcp' ? 'active' : ''}"
              data-ib-target="section:setup/mcp"
              data-learn-id="setup-nav-mcp"
              @click=${() => handleSectionChange('mcp')}
            >
              <span class="nav-icon">${icons.plug}</span>
              <div class="nav-info">
                <div class="nav-title">MCP Integration</div>
                <div class="nav-desc">Claude Desktop tools</div>
              </div>
              <span class="nav-status ${setupState.mcpEnabled ? 'ok' : 'warning'}">
                ${setupState.mcpEnabled ? 'Active' : 'Setup'}
              </span>
            </div>
            
            <div 
              class="setup-nav-item ${setupState.activeSection === 'docker' ? 'active' : ''}"
              data-ib-target="section:setup/docker"
              @click=${() => handleSectionChange('docker')}
            >
              <span class="nav-icon">${icons.container}</span>
              <div class="nav-info">
                <div class="nav-title">Docker</div>
                <div class="nav-desc">Container deployment</div>
              </div>
              <span class="nav-status ${setupState.dockerAvailable ? 'ok' : 'warning'}">
                ${setupState.dockerAvailable ? setupState.dockerStatus : 'N/A'}
              </span>
            </div>
            
            <div 
              class="setup-nav-item ${setupState.activeSection === 'wizard' ? 'active' : ''}"
              data-ib-target="section:setup/wizard"
              @click=${() => { _wizardExplicit = true; handleSectionChange('wizard'); }}
            >
              <span class="nav-icon">${icons.wand}</span>
              <div class="nav-info">
                <div class="nav-title">${onboardingFinished() ? "Your setup" : "Get started"}</div>
                <div class="nav-desc">${onboardingFinished() ? "Edit any one setting" : "Goals, model, channels, voice"}</div>
              </div>
              <span class="nav-status ${onboardingFinished() ? 'ok' : 'warning'}">
                ${onboardingFinished() ? 'Done' : 'Run'}
              </span>
            </div>
            
            <div 
              class="setup-nav-item ${setupState.activeSection === 'wizard-advanced' ? 'active' : ''}"
              data-ib-target="section:setup/wizard-advanced"
              @click=${() => handleSectionChange('wizard-advanced')}
            >
              <span class="nav-icon">${icons.sliders}</span>
              <div class="nav-info">
                <div class="nav-title">Advanced wizard</div>
                <div class="nav-desc">Federation, coders, Notion</div>
              </div>
            </div>

            <div 
              class="setup-nav-item ${setupState.activeSection === 'install' ? 'active' : ''}"
              data-ib-target="section:setup/install"
              data-learn-id="setup-nav-install"
              @click=${() => handleSectionChange('install')}
            >
              <span class="nav-icon">${icons.smartphone}</span>
              <div class="nav-info">
                <div class="nav-title">Install & Connect</div>
                <div class="nav-desc">Apps & device pairing</div>
              </div>
              <span class="nav-status ok">Ready</span>
            </div>
            
            <div
              class="setup-nav-item ${setupState.activeSection === 'remote' ? 'active' : ''}"
              data-ib-target="section:setup/remote"
              data-testid="setup-nav-remote"
              @click=${() => handleSectionChange('remote')}
            >
              <span class="nav-icon">${icons.globe}</span>
              <div class="nav-info">
                <div class="nav-title">Remote access</div>
                <div class="nav-desc">Tailscale link + phone</div>
              </div>
            </div>

            <div 
              class="setup-nav-item ${setupState.activeSection === 'network' ? 'active' : ''}"
              data-ib-target="section:setup/network"
              @click=${() => handleSectionChange('network')}
            >
              <span class="nav-icon">${icons.globe}</span>
              <div class="nav-info">
                <div class="nav-title">Network</div>
                <div class="nav-desc">Multi-instance federation</div>
              </div>
              <span class="nav-status ${networkState.instances.length > 1 ? 'ok' : 'warning'}">
                ${networkState.instances.filter(i => i.status === 'online').length}/${networkState.instances.length}
              </span>
            </div>
            
            <div
              class="setup-nav-item ${setupState.activeSection === 'instance' ? 'active' : ''}"
              data-ib-target="section:setup/instance"
              @click=${() => handleSectionChange('instance')}
            >
              <span class="nav-icon">${icons.house}</span>
              <div class="nav-info">
                <div class="nav-title">Instance</div>
                <div class="nav-desc">Name, role, providers</div>
              </div>
            </div>

            <!-- COORDINATION: opencode-swap -->
            <div
              class="setup-nav-item ${setupState.activeSection === 'coder-backend' ? 'active' : ''}"
              data-ib-target="section:setup/coder-backend"
              @click=${() => handleSectionChange('coder-backend')}
            >
              <span class="nav-icon">${icons.zap}</span>
              <div class="nav-info">
                <div class="nav-title">Coding Backend</div>
                <div class="nav-desc">Claude Code or OpenCode</div>
              </div>
            </div>

            <div
              class="setup-nav-item ${setupState.activeSection === 'coders' ? 'active' : ''}"
              data-ib-target="section:setup/coders"
              @click=${() => handleSectionChange('coders')}
            >
              <span class="nav-icon">${icons.terminal ?? icons.zap}</span>
              <div class="nav-info">
                <div class="nav-title">Coders</div>
                <div class="nav-desc">Install & sign in coding CLIs</div>
              </div>
              <span class="nav-status ok">New</span>
            </div>

            <div
              class="setup-nav-item ${setupState.activeSection === 'kinglyvault' ? 'active' : ''}"
              data-ib-target="section:setup/kinglyvault"
              @click=${() => handleSectionChange('kinglyvault')}
            >
              <span class="nav-icon">${icons.link ?? icons.zap}</span>
              <div class="nav-info">
                <div class="nav-title">Connect KinglyVault</div>
                <div class="nav-desc">Link your KinglyVault account</div>
              </div>
            </div>

            <div
              class="setup-nav-item ${setupState.activeSection === 'components' ? 'active' : ''}"
              data-ib-target="section:setup/components"
              @click=${() => handleSectionChange('components')}
            >
              <span class="nav-icon">${icons.download ?? icons.zap}</span>
              <div class="nav-info">
                <div class="nav-title">Components</div>
                <div class="nav-desc">Optional LLM / video packs</div>
              </div>
              <span class="nav-status warning">Optional</span>
            </div>

            <div
              class="setup-nav-item ${setupState.activeSection === 'voice' ? 'active' : ''}"
              data-ib-target="section:setup/voice"
              @click=${() => handleSectionChange('voice')}
            >
              <span class="nav-icon">${icons.mic ?? icons.zap}</span>
              <div class="nav-info">
                <div class="nav-title">Voice</div>
                <div class="nav-desc">Local voice by default · Cloud voice optional</div>
              </div>
              <span class="nav-status warning">Optional</span>
            </div>
          </div>
          
          <div class="setup-content">
            ${setupState.activeSection === 'quickstart' ? renderQuickstart(setupState, () => state.requestUpdate?.(), client) : nothing}
            ${setupState.activeSection === 'overview' ? renderOverviewSection(setupState, handleSectionChange) : nothing}
            ${setupState.activeSection === 'mcp' ? renderMcpSection(setupState) : nothing}
            ${setupState.activeSection === 'docker' ? renderDockerSection(setupState) : nothing}
            ${setupState.activeSection === 'wizard' ? renderOnboardingSection(state, client) : nothing}
            ${setupState.activeSection === 'wizard-advanced' ? renderSetupWizard(state, client) : nothing}
            ${setupState.activeSection === 'install' ? renderInstallSection(setupState, client, () => state.requestUpdate?.()) : nothing}
            ${setupState.activeSection === 'network' ? renderNetworkSection(networkState, {
              onConnect: (id) => {
                setActiveInstance(id, (update) => {
                  state.networkState = { ...state.networkState!, ...update };
                  state.requestUpdate?.();
                });
              },
              onRemove: (id) => {
                removeInstance(id, (update) => {
                  state.networkState = { ...state.networkState!, ...update };
                  state.requestUpdate?.();
                }, networkState);
              },
              onRefresh: async (id) => {
                const instance = networkState.instances.find(i => i.id === id);
                if (instance) {
                  const updated = await checkInstanceStatus(instance);
                  const instances = networkState.instances.map(i => i.id === id ? updated : i);
                  state.networkState = { ...state.networkState!, instances };
                  state.requestUpdate?.();
                }
              },
              onShowAdd: () => {
                showAddInstanceDialog((update) => {
                  state.networkState = { ...state.networkState!, ...update };
                  state.requestUpdate?.();
                });
              },
              onHideAdd: () => {
                hideAddInstanceDialog((update) => {
                  state.networkState = { ...state.networkState!, ...update };
                  state.requestUpdate?.();
                });
              },
              onAddSubmit: async () => {
                await addInstance(
                  networkState.addInstanceForm,
                  (update) => {
                    state.networkState = { ...state.networkState!, ...update };
                    state.requestUpdate?.();
                  },
                  networkState
                );
              },
              onFieldChange: (field, value) => {
                updateAddInstanceForm(field, value, (update) => {
                  state.networkState = { ...state.networkState!, ...update };
                  state.requestUpdate?.();
                }, networkState);
              },
            }) : nothing}
            ${setupState.activeSection === 'instance' ? renderInstanceSection(setupState) : nothing}
            ${setupState.activeSection === 'coder-backend' ? renderCoderBackendSection(state, client) : nothing}
            ${setupState.activeSection === 'coders' ? (loadCodersSettings(), html`
              <div class="content-body"><coders-settings></coders-settings></div>
            `) : nothing}
            ${setupState.activeSection === 'kinglyvault' ? (loadKvConnectSettings(), html`
              <div class="content-body"><kv-connect-settings></kv-connect-settings></div>
            `) : nothing}
            ${setupState.activeSection === 'components' ? (loadComponentsSettings(), html`
              <div class="content-body"><components-settings></components-settings></div>
            `) : nothing}
            ${setupState.activeSection === 'voice' ? renderVoiceSetupSection(state) : nothing}
            ${setupState.activeSection === 'remote' ? renderRemoteAccessSection(state) : nothing}
          </div>
        </div>
      `}
    </div>
  `;
}

export default renderSetup;
