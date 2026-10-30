/**
 * Global locale + minimal i18n helper.
 *
 * Locale is persisted via `UiSettings.locale` (localStorage) and surfaced in
 * the topbar language toggle. Views call `t(key, params?, fallback?)` to look
 * up a string. Lookup falls back: requested locale → English entry →
 * caller-supplied `fallback` (the English *source* string) → the key itself.
 * That means a view can pass its existing hardcoded English string as the
 * fallback and never render a raw key or `undefined`, even before a key has
 * been translated.
 *
 * Add translations by appending to `STRINGS` below — keys are dotted paths
 * chosen by the calling site (e.g. `nav.group.home`, `tab.title.business`).
 * For keys where the English text already lives in the source (e.g.
 * `titleForTab`), you only need to add the *non-English* entries here; the
 * source string is passed in as `fallback`.
 *
 * Values may hold `{name}` style placeholders — pass `params` to interpolate
 * them (`t("greeting", { name: "Sam" })`) instead of string-concatenating.
 *
 * Re-render: `applySettings` calls `setCurrentLocale` and assigns the reactive
 * `@state() settings`, which re-runs the whole Lit render tree. Because every
 * `t(...)` call reads `currentLocale` at render time, switching language
 * re-translates all visible text live and any view opened afterwards renders
 * in the chosen language too — no manual reload required. For non-Lit
 * consumers (e.g. imperative `textContent =` code) subscribe via
 * `onLocaleChange(cb)`; `setCurrentLocale` fires it on every change.
 */

export type AppLocale = "en" | "es" | "fr" | "de" | "th" | "zh" | "ja";

export const APP_LOCALES: AppLocale[] = ["en", "es", "fr", "de", "th", "zh", "ja"];

export const LOCALE_LABELS: Record<AppLocale, { native: string; short: string; flag: string }> = {
  en: { native: "English", short: "EN", flag: "🇺🇸" },
  es: { native: "Español", short: "ES", flag: "🇪🇸" },
  fr: { native: "Français", short: "FR", flag: "🇫🇷" },
  de: { native: "Deutsch", short: "DE", flag: "🇩🇪" },
  th: { native: "ไทย", short: "TH", flag: "🇹🇭" },
  zh: { native: "中文", short: "ZH", flag: "🇨🇳" },
  ja: { native: "日本語", short: "JA", flag: "🇯🇵" },
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as string[]).includes(value);
}

/** Detect a sensible default from `navigator.language`. */
export function detectLocale(): AppLocale {
  try {
    const raw = (navigator?.language || "en").toLowerCase();
    if (raw.startsWith("es")) return "es";
    if (raw.startsWith("fr")) return "fr";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("th")) return "th";
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("ja")) return "ja";
  } catch {
    /* ignore */
  }
  return "en";
}

type StringTable = Partial<Record<AppLocale, string>>;

/**
 * Translation table. English (`en`) is optional for any key whose source site
 * already passes the English text as the `fallback` arg to `t()` (e.g. every
 * `tab.title.*` / `tab.subtitle.*` key — the English lives in `navigation.ts`).
 *
 * Coverage: `es`/`fr`/`de`/`th` are FULL for all keys below (every visible
 * chrome string the language toggle controls, plus the page-body keys for the
 * views routed through `t()`). `zh`/`ja` remain partial and fall back to
 * English for keys without an entry — safe, never shows a raw key.
 */
const STRINGS: Record<string, StringTable> = {
  // ── Terminals: Layouts dropdown ───────────────────────────────────────
  "terminals.layouts.button": { en: "Layouts", es: "Diseños", fr: "Dispositions", de: "Layouts" },
  "terminals.layouts.quick": { en: "Quick Layouts", es: "Diseños rápidos", fr: "Dispositions rapides", de: "Schnell-Layouts" },
  "terminals.layouts.current": { en: "Current Layout", es: "Diseño actual", fr: "Disposition actuelle", de: "Aktuelles Layout" },
  "terminals.layouts.save": { en: "Save current as preset…", es: "Guardar como preajuste…", fr: "Enregistrer comme préréglage…", de: "Als Voreinstellung speichern…" },
  "terminals.layouts.saved": { en: "Saved ({count})", es: "Guardados ({count})", fr: "Enregistrés ({count})", de: "Gespeichert ({count})" },
  "terminals.layouts.none": { en: "No saved layouts", es: "Sin diseños guardados", fr: "Aucune disposition enregistrée", de: "Keine gespeicherten Layouts" },
  "terminals.layouts.delete": { en: "Delete preset", es: "Eliminar preajuste", fr: "Supprimer le préréglage", de: "Voreinstellung löschen" },
  "terminals.layouts.unit": { en: "terminals", es: "terminales", fr: "terminaux", de: "Terminals" },
  "terminals.layouts.preset.one": { en: "1-up", es: "1 panel", fr: "1 plein", de: "1 groß" },
  "terminals.layouts.preset.twoCol": { en: "2 columns", es: "2 columnas", fr: "2 colonnes", de: "2 Spalten" },
  "terminals.layouts.preset.threeCol": { en: "3 columns", es: "3 columnas", fr: "3 colonnes", de: "3 Spalten" },
  "terminals.layouts.preset.grid": { en: "2×2 grid", es: "Cuadrícula 2×2", fr: "Grille 2×2", de: "2×2-Raster" },
  "terminals.layouts.preset.focusLeft": { en: "Focus left", es: "Enfoque izquierda", fr: "Focus à gauche", de: "Fokus links" },
  "terminals.layouts.preset.focusRight": { en: "Focus right", es: "Enfoque derecha", fr: "Focus à droite", de: "Fokus rechts" },
  "terminals.layouts.savePrompt": { en: "Save terminal layout as:", es: "Guardar diseño de terminal como:", fr: "Enregistrer la disposition comme :", de: "Terminal-Layout speichern als:" },
  "terminals.layouts.deleteConfirm": { en: "Delete preset \"{name}\"?", es: "¿Eliminar el preajuste «{name}»?", fr: "Supprimer le préréglage « {name} » ?", de: "Voreinstellung „{name}“ löschen?" },
  // ── Agent config: Integrations & Backend ──────────────────────────────
  "agent.integrations.tab": { en: "Integrations & Backend", es: "Integraciones y backend", fr: "Intégrations et backend", de: "Integrationen & Backend" },
  "agent.integrations.telegram.title": { en: "Telegram bot token", es: "Token del bot de Telegram", fr: "Jeton du bot Telegram", de: "Telegram-Bot-Token" },
  "agent.integrations.telegram.hint": { en: "Outbound notifications for this agent use this token. Stored encrypted; falls back to the global token when unset.", es: "Las notificaciones salientes de este agente usan este token. Se guarda cifrado; usa el token global si no se define." },
  "agent.integrations.telegram.label": { en: "Bot token", es: "Token del bot", fr: "Jeton du bot", de: "Bot-Token" },
  "agent.integrations.telegram.isSet": { en: "Agent token is set", es: "El token del agente está configurado" },
  "agent.integrations.telegram.notSet": { en: "No agent token — using global", es: "Sin token del agente — usando el global" },
  "agent.integrations.telegram.save": { en: "Save token", es: "Guardar token", fr: "Enregistrer", de: "Speichern" },
  "agent.integrations.telegram.clear": { en: "Remove", es: "Eliminar", fr: "Supprimer", de: "Entfernen" },
  "agent.integrations.telegram.test": { en: "Send test", es: "Enviar prueba", fr: "Envoyer un test", de: "Test senden" },
  "agent.integrations.telegram.testing": { en: "Sending…", es: "Enviando…", fr: "Envoi…", de: "Senden…" },
  "agent.integrations.telegram.testOk": { en: "Test message sent", es: "Mensaje de prueba enviado" },
  "agent.integrations.telegram.saved": { en: "Token saved (encrypted).", es: "Token guardado (cifrado)." },
  "agent.integrations.telegram.cleared": { en: "Token removed.", es: "Token eliminado." },
  "agent.integrations.backends.title": { en: "CLI coder backend", es: "Backend del programador CLI" },
  "agent.integrations.backends.hint": { en: "Which CLI backend this agent spawns by default, and which to retry once with if it fails to start.", es: "Qué backend CLI usa este agente por defecto y con cuál reintentar una vez si no arranca." },
  "agent.integrations.backends.default": { en: "Default backend", es: "Backend predeterminado", fr: "Backend par défaut", de: "Standard-Backend" },
  "agent.integrations.backends.fallback": { en: "Fallback backend", es: "Backend de reserva", fr: "Backend de secours", de: "Ausweich-Backend" },
  "agent.integrations.backends.useGlobal": { en: "Use global default", es: "Usar el predeterminado global" },
  "agent.integrations.backends.none": { en: "None", es: "Ninguno", fr: "Aucun", de: "Keiner" },
  "agent.integrations.backends.save": { en: "Save backends", es: "Guardar backends" },
  "agent.integrations.backends.saved": { en: "Backend settings saved.", es: "Configuración de backend guardada." },
  // ── Branding modal (topbar brand → Customize branding) ────────────────
  "branding.modal.open": { en: "Customize branding", es: "Personalizar marca", fr: "Personnaliser la marque", de: "Branding anpassen", th: "ปรับแต่งแบรนด์", zh: "自定义品牌", ja: "ブランドをカスタマイズ" },
  "branding.modal.title": { en: "Customize branding", es: "Personalizar marca", fr: "Personnaliser la marque", de: "Branding anpassen", th: "ปรับแต่งแบรนด์", zh: "自定义品牌", ja: "ブランドをカスタマイズ" },
  "branding.modal.preview": { en: "Preview", es: "Vista previa", fr: "Aperçu", de: "Vorschau", th: "ตัวอย่าง", zh: "预览", ja: "プレビュー" },
  "branding.modal.brandTitle": { en: "Brand title", es: "Título de la marca", fr: "Titre de la marque", de: "Markentitel", th: "ชื่อแบรนด์", zh: "品牌标题", ja: "ブランド名" },
  "branding.modal.brandSubtitle": { en: "Brand subtitle", es: "Subtítulo de la marca", fr: "Sous-titre de la marque", de: "Marken-Untertitel", th: "คำบรรยายแบรนด์", zh: "品牌副标题", ja: "サブタイトル" },
  "branding.modal.logo": { en: "Logo", es: "Logotipo", fr: "Logo", de: "Logo", th: "โลโก้", zh: "标志", ja: "ロゴ" },
  "branding.modal.dropHint": { en: "Drag & drop an image, or click to choose", es: "Arrastra una imagen o haz clic para elegir", fr: "Glissez une image ou cliquez pour choisir", de: "Bild hierher ziehen oder klicken", th: "ลากรูปภาพมาวาง หรือคลิกเพื่อเลือก", zh: "拖放图片，或点击选择", ja: "画像をドラッグ＆ドロップ、またはクリックして選択" },
  "branding.modal.logoFormats": { en: "PNG, JPG, SVG or WebP · up to 2 MB", es: "PNG, JPG, SVG o WebP · hasta 2 MB", fr: "PNG, JPG, SVG ou WebP · jusqu'à 2 Mo", de: "PNG, JPG, SVG oder WebP · bis 2 MB", th: "PNG, JPG, SVG หรือ WebP · สูงสุด 2 MB", zh: "PNG、JPG、SVG 或 WebP · 最大 2 MB", ja: "PNG・JPG・SVG・WebP · 最大2MB" },
  "branding.modal.useUrl": { en: "Use a URL instead", es: "Usar una URL en su lugar", fr: "Utiliser une URL à la place", de: "Stattdessen URL verwenden", th: "ใช้ URL แทน", zh: "改用网址", ja: "代わりにURLを使う" },
  "branding.modal.logoUrl": { en: "Logo URL", es: "URL del logotipo", fr: "URL du logo", de: "Logo-URL", th: "URL โลโก้", zh: "标志网址", ja: "ロゴのURL" },
  "branding.modal.reset": { en: "Reset to default", es: "Restablecer", fr: "Réinitialiser", de: "Zurücksetzen", th: "รีเซ็ตเป็นค่าเริ่มต้น", zh: "恢复默认", ja: "デフォルトに戻す" },
  "branding.modal.save": { en: "Save", es: "Guardar", fr: "Enregistrer", de: "Speichern", th: "บันทึก", zh: "保存", ja: "保存" },
  "branding.modal.saving": { en: "Saving…", es: "Guardando…", fr: "Enregistrement…", de: "Wird gespeichert…", th: "กำลังบันทึก…", zh: "保存中…", ja: "保存中…" },
  "branding.modal.cancel": { en: "Cancel", es: "Cancelar", fr: "Annuler", de: "Abbrechen", th: "ยกเลิก", zh: "取消", ja: "キャンセル" },
  "branding.modal.close": { en: "Close", es: "Cerrar", fr: "Fermer", de: "Schließen", th: "ปิด", zh: "关闭", ja: "閉じる" },
  "branding.modal.tooLarge": { en: "Image is too large (max 2 MB)", es: "La imagen es demasiado grande (máx. 2 MB)", fr: "Image trop volumineuse (max 2 Mo)", de: "Bild zu groß (max. 2 MB)", th: "รูปภาพใหญ่เกินไป (สูงสุด 2 MB)", zh: "图片太大（最大 2 MB）", ja: "画像が大きすぎます（最大2MB）" },
  "branding.modal.notImage": { en: "File must be a PNG, JPG, SVG or WebP image", es: "El archivo debe ser PNG, JPG, SVG o WebP", fr: "Le fichier doit être une image PNG, JPG, SVG ou WebP", de: "Datei muss PNG, JPG, SVG oder WebP sein", th: "ไฟล์ต้องเป็น PNG, JPG, SVG หรือ WebP", zh: "文件必须是 PNG、JPG、SVG 或 WebP 图片", ja: "ファイルはPNG・JPG・SVG・WebP画像である必要があります" },
  // ── Topbar / shell ────────────────────────────────────────────────────
  "topbar.language": { en: "Language", es: "Idioma", fr: "Langue", de: "Sprache", th: "ภาษา", zh: "语言", ja: "言語" },
  "topbar.theme": { en: "Theme", es: "Tema", fr: "Thème", de: "Thema", th: "ธีม", zh: "主题", ja: "テーマ" },
  "topbar.theme.system": { en: "System", es: "Sistema", fr: "Système", de: "System", th: "ระบบ" },
  "topbar.theme.light": { en: "Light", es: "Claro", fr: "Clair", de: "Hell", th: "สว่าง" },
  "topbar.theme.dark": { en: "Dark", es: "Oscuro", fr: "Sombre", de: "Dunkel", th: "มืด" },
  "topbar.refreshChat": { en: "Refresh chat history", es: "Actualizar historial de chat", fr: "Actualiser l'historique du chat", de: "Chatverlauf aktualisieren", th: "รีเฟรชประวัติแชท" },
  "topbar.selectModel": { en: "Select model for this session", es: "Seleccionar modelo para esta sesión", fr: "Sélectionner le modèle pour cette session", de: "Modell für diese Sitzung auswählen", th: "เลือกโมเดลสำหรับเซสชันนี้" },
  "topbar.configurePrompt": { en: "Configure system prompt", es: "Configurar instrucción del sistema", fr: "Configurer l'invite système", de: "Systemprompt konfigurieren", th: "กำหนดค่าพรอมต์ระบบ" },
  "topbar.restartGateway": { en: "Restart Gateway", es: "Reiniciar Gateway", fr: "Redémarrer la passerelle", de: "Gateway neu starten", th: "รีสตาร์ทเกตเวย์" },
  "topbar.newWindow": { en: "Open New Window", es: "Abrir nueva ventana", fr: "Ouvrir une nouvelle fenêtre", de: "Neues Fenster öffnen", th: "เปิดหน้าต่างใหม่" },
  "topbar.restart": { en: "Restart", es: "Reiniciar", fr: "Redémarrer", de: "Neu starten", th: "รีสตาร์ท" },
  "topbar.restarting": { en: "Restarting…", es: "Reiniciando…", fr: "Redémarrage…", de: "Wird neu gestartet…", th: "กำลังรีสตาร์ท…" },
  "topbar.toggleThinking": { en: "Toggle thinking visibility", es: "Mostrar/ocultar razonamiento", fr: "Afficher/masquer le raisonnement", de: "Denkprozess ein-/ausblenden", th: "สลับการแสดงกระบวนการคิด" },
  "topbar.toggleFocus": {
    en: "Toggle focus mode (hide sidebar + page header)",
    es: "Modo enfoque (ocultar barra lateral y encabezado)",
    fr: "Mode focus (masquer la barre latérale et l'en-tête)",
    de: "Fokusmodus (Seitenleiste und Kopfzeile ausblenden)",
    th: "สลับโหมดโฟกัส (ซ่อนแถบข้างและส่วนหัวของหน้า)",
  },

  // ── Common buttons / labels ───────────────────────────────────────────
  "common.save": { en: "Save", es: "Guardar", fr: "Enregistrer", de: "Speichern", th: "บันทึก" },
  "common.cancel": { en: "Cancel", es: "Cancelar", fr: "Annuler", de: "Abbrechen", th: "ยกเลิก" },
  "common.close": { en: "Close", es: "Cerrar", fr: "Fermer", de: "Schließen", th: "ปิด" },
  "common.delete": { en: "Delete", es: "Eliminar", fr: "Supprimer", de: "Löschen", th: "ลบ" },
  "common.add": { en: "Add", es: "Añadir", fr: "Ajouter", de: "Hinzufügen", th: "เพิ่ม" },
  "common.edit": { en: "Edit", es: "Editar", fr: "Modifier", de: "Bearbeiten", th: "แก้ไข" },
  "common.search": { en: "Search", es: "Buscar", fr: "Rechercher", de: "Suchen", th: "ค้นหา" },
  "common.send": { en: "Send", es: "Enviar", fr: "Envoyer", de: "Senden", th: "ส่ง" },
  "common.refresh": { en: "Refresh", es: "Actualizar", fr: "Actualiser", de: "Aktualisieren", th: "รีเฟรช" },
  "common.loading": { en: "Loading...", es: "Cargando...", fr: "Chargement...", de: "Wird geladen...", th: "กำลังโหลด..." },
  "common.settings": { en: "Settings", es: "Ajustes", fr: "Paramètres", de: "Einstellungen", th: "การตั้งค่า" },
  "common.confirm": { en: "Confirm", es: "Confirmar", fr: "Confirmer", de: "Bestätigen", th: "ยืนยัน" },
  "common.retry": { en: "Retry", es: "Reintentar", fr: "Réessayer", de: "Wiederholen", th: "ลองใหม่" },

  // ── MCP Quick Install ─────────────────────────────────────────────────
  "mcp.qi.title": { en: "Quick Install — connect external agents to this InfiniBot" },
  "mcp.qi.subtitle": { en: "Point any CLI or MCP client at this gateway in seconds." },
  "mcp.qi.scope.local": { en: "Local" },
  "mcp.qi.scope.lan": { en: "LAN" },
  "mcp.qi.scope.tailscale": { en: "Tailscale" },
  "mcp.qi.scope.local.hint": { en: "Same machine. Zero config, fastest." },
  "mcp.qi.scope.lan.hint": { en: "Same network. Reachable from other devices on this Wi-Fi/LAN." },
  "mcp.qi.scope.tailscale.hint": { en: "Remote secure access over your tailnet — recommended for reaching this gateway from outside the LAN." },
  "mcp.qi.reach.ok": { en: "Reachable" },
  "mcp.qi.reach.warn": { en: "Unverified" },
  "mcp.qi.reach.down": { en: "Unavailable" },
  "mcp.qi.client": { en: "Client" },
  "mcp.qi.os": { en: "OS" },
  "mcp.qi.endpoint": { en: "Endpoint" },
  "mcp.qi.configPath": { en: "Config file" },
  "mcp.qi.copy": { en: "Copy" },
  "mcp.qi.copied": { en: "Copied!" },
  "mcp.qi.apiKey": { en: "Gateway API key" },
  "mcp.qi.reveal": { en: "Reveal key" },
  "mcp.qi.hide": { en: "Hide key" },
  "mcp.qi.rotate": { en: "Rotate key" },
  "mcp.qi.noAuth": { en: "No auth required — this gateway is bound to loopback and accepts local connections without a key." },
  "mcp.qi.lanWarning": { en: "Exposes the gateway on your local network. Enable an API key (above) so only trusted clients can connect." },
  "mcp.qi.tailscaleMissing": { en: "Tailscale not detected. Install Tailscale and run tailscale up, then refresh — the gateway will be reachable at your tailnet hostname." },
  "mcp.qi.whyScopes": { en: "Why these scopes?" },
  "mcp.qi.refresh": { en: "Refresh" },
  "mcp.qi.rotateConfirm": { en: "Rotate the gateway key now? This restarts the gateway and disconnects every currently-connected client until they're re-added with the new key." },

  // ── System prompt modal (topbar chrome) ───────────────────────────────
  "prompt.modalTitle": { en: "System Prompt Configuration", es: "Configuración de instrucción del sistema", fr: "Configuration de l'invite système", de: "Systemprompt-Konfiguration", th: "การกำหนดค่าพรอมต์ระบบ" },

  // ── Chat view ─────────────────────────────────────────────────────────
  "chat.empty": {
    en: "Start a conversation...",
    es: "Inicia una conversación...",
    fr: "Démarrez une conversation...",
    de: "Beginnen Sie ein Gespräch...",
    th: "เริ่มการสนทนา...",
    zh: "开始对话...",
    ja: "会話を始めましょう...",
  },

  // ── Nav group labels (TAB_GROUPS) ─────────────────────────────────────
  // Keys are `nav.group.${label.toLowerCase()}` (see groupLabel()).
  "nav.group.home": { es: "Inicio", fr: "Accueil", de: "Start", th: "หน้าแรก" },
  "nav.group.chat & voice": { es: "Chat y voz", fr: "Chat et voix", de: "Chat & Stimme", th: "แชทและเสียง" },
  "nav.group.work": { es: "Trabajo", fr: "Travail", de: "Arbeit", th: "งาน" },
  "nav.group.business": { es: "Negocio", fr: "Entreprise", de: "Geschäft", th: "ธุรกิจ" },
  "nav.group.agents": { es: "Agentes", fr: "Agents", de: "Agenten", th: "เอเจนต์" },
  "nav.group.settings": { es: "Ajustes", fr: "Paramètres", de: "Einstellungen", th: "การตั้งค่า" },
  // Pre-consolidation group labels — kept for sidebars saved before the regroup
  // (e.g. a custom category a user named "Media").
  "nav.group.chat": { es: "Chat", fr: "Chat", de: "Chat", th: "แชท" },
  "nav.group.media": { es: "Multimedia", fr: "Médias", de: "Medien", th: "สื่อ" },
  "nav.group.agent": { es: "Agente", fr: "Agent", de: "Agent", th: "เอเจนต์" },
  "nav.group.focus": { es: "Enfoque", fr: "Focus", de: "Fokus", th: "โฟกัส" },
  "nav.alsoHere": { en: "Also here", es: "También aquí", fr: "Aussi ici", de: "Auch hier", th: "มีที่นี่ด้วย" },
  "nav.partOf": { en: "Part of", es: "Parte de", fr: "Fait partie de", de: "Teil von", th: "ส่วนหนึ่งของ" },
  "nav.hiddenTabs": { en: "Hidden Tabs", es: "Pestañas ocultas", fr: "Onglets masqués", de: "Ausgeblendete Tabs", th: "แท็บที่ซ่อน" },
  "nav.resources": { en: "Resources", es: "Recursos", fr: "Ressources", de: "Ressourcen", th: "ทรัพยากร" },
  "nav.moveTo": { en: "Move to:", es: "Mover a:", fr: "Déplacer vers :", de: "Verschieben nach:", th: "ย้ายไปยัง:" },

  // ── Tab titles (en lives in titleForTab; only non-en needed here) ──────
  "tab.title.overview": { es: "Resumen", fr: "Aperçu", de: "Übersicht", th: "ภาพรวม" },
  "tab.title.dashboard": { es: "Panel", fr: "Tableau de bord", de: "Dashboard", th: "แดชบอร์ด" },
  "tab.title.chat": { es: "Chat", fr: "Chat", de: "Chat", th: "แชท" },
  "tab.title.grid": { es: "Cuadrícula", fr: "Grille", de: "Raster", th: "กริด" },
  "tab.title.voice": { es: "Voz", fr: "Voix", de: "Stimme", th: "เสียง" },
  "tab.title.voicecommands": { es: "Comandos de voz", fr: "Commandes vocales", de: "Sprachbefehle", th: "คำสั่งเสียง" },
  "tab.title.video": { es: "Vídeo", fr: "Vidéo", de: "Video", th: "วิดีโอ" },
  "tab.title.storyboard": { es: "Estudio de guion gráfico", fr: "Studio storyboard", de: "Storyboard-Studio", th: "สตูดิโอสตอรีบอร์ด" },
  "tab.title.whiteboard": { es: "Pizarra", fr: "Tableau blanc", de: "Whiteboard", th: "ไวต์บอร์ด" },
  "tab.title.design": { es: "Diseño", fr: "Conception", de: "Design", th: "ออกแบบ" },
  "tab.title.projects": { es: "Proyectos", fr: "Projets", de: "Projekte", th: "โปรเจกต์" },
  "tab.title.databases": { es: "Bases de datos", fr: "Bases de données", de: "Datenbanken", th: "ฐานข้อมูล" },
  "tab.title.business": { es: "Negocio", fr: "Entreprise", de: "Geschäft", th: "ธุรกิจ" },
  "tab.title.clients": { es: "Clientes", fr: "Clients", de: "Kunden", th: "ลูกค้า" },
  "tab.title.leads": { es: "Panel de prospectos", fr: "Tableau des prospects", de: "Lead-Dashboard", th: "แดชบอร์ดลูกค้าเป้าหมาย" },
  "tab.title.qualifier": { es: "Panel de prospectos", fr: "Tableau des prospects", de: "Lead-Dashboard", th: "แดชบอร์ดลูกค้าเป้าหมาย" },
  "tab.title.pipeline": { es: "Panel de prospectos", fr: "Tableau des prospects", de: "Lead-Dashboard", th: "แดชบอร์ดลูกค้าเป้าหมาย" },
  "tab.title.campaigns": { es: "Campañas", fr: "Campagnes", de: "Kampagnen", th: "แคมเปญ" },
  "tab.title.inbox": { es: "Bandeja de entrada", fr: "Boîte de réception", de: "Posteingang", th: "กล่องข้อความ" },
  "tab.title.reply-inbox": { es: "Bandeja de respuestas", fr: "Boîte de réponses", de: "Antwort-Posteingang", th: "กล่องข้อความตอบกลับ" },
  "tab.title.email": { es: "Correos", fr: "E-mails", de: "E-Mails", th: "อีเมล" },
  "tab.title.emails": { es: "Correos", fr: "E-mails", de: "E-Mails", th: "อีเมล" },
  "tab.title.messages": { es: "Mensajes", fr: "Messages", de: "Nachrichten", th: "ข้อความ" },
  "tab.title.products": { es: "Productos", fr: "Produits", de: "Produkte", th: "สินค้า" },
  "tab.title.funnels": { es: "Embudos", fr: "Entonnoirs", de: "Trichter", th: "ฟันเนล" },
  "tab.title.content-pages": { es: "Páginas de contenido", fr: "Pages de contenu", de: "Inhaltsseiten", th: "หน้าเนื้อหา" },
  "tab.title.agents": { es: "Agentes", fr: "Agents", de: "Agenten", th: "เอเจนต์" },
  "tab.title.activity": { es: "Actividad", fr: "Activité", de: "Aktivität", th: "กิจกรรม" },
  "tab.title.mesh": { es: "Malla de agentes", fr: "Maillage d'agents", de: "Agenten-Mesh", th: "แผนที่เอเจนต์" },
  "tab.title.subagents": { es: "Subagentes", fr: "Sous-agents", de: "Unteragenten", th: "ซับเอเจนต์" },
  "tab.title.sessions": { es: "Sesiones", fr: "Sessions", de: "Sitzungen", th: "เซสชัน" },
  "tab.title.instances": { es: "Instancias", fr: "Instances", de: "Instanzen", th: "อินสแตนซ์" },
  "tab.title.cron": { es: "Tareas Cron", fr: "Tâches Cron", de: "Cron-Jobs", th: "งานครอน" },
  "tab.title.schedule": { es: "Agenda", fr: "Agenda", de: "Zeitplan", th: "ตารางเวลา" },
  "tab.title.autonomy": { es: "Autonomía", fr: "Autonomie", de: "Autonomie", th: "ความเป็นอิสระ" },
  "tab.title.workflows": { es: "Flujos de trabajo", fr: "Flux de travail", de: "Arbeitsabläufe", th: "เวิร์กโฟลว์" },
  "tab.title.workspace": { es: "Espacio de trabajo", fr: "Espace de travail", de: "Arbeitsbereich", th: "พื้นที่ทำงาน" },
  "tab.title.memory": { es: "Memoria", fr: "Mémoire", de: "Speicher", th: "หน่วยความจำ" },
  "tab.title.notes": { es: "Notas", fr: "Notes", de: "Notizen", th: "บันทึก" },
  "tab.title.prompt-templates": { es: "Plantillas de instrucciones", fr: "Modèles d'invite", de: "Prompt-Vorlagen", th: "เทมเพลตพรอมต์" },
  "tab.title.research": { es: "Investigación", fr: "Recherche", de: "Recherche", th: "การวิจัย" },
  "tab.title.skills": { es: "Habilidades", fr: "Compétences", de: "Fähigkeiten", th: "ทักษะ" },
  "tab.title.nodes": { es: "Nodos", fr: "Nœuds", de: "Knoten", th: "โหนด" },
  "tab.title.mcp": { es: "MCP", fr: "MCP", de: "MCP", th: "MCP" },
  "tab.title.terminals": { es: "Terminales", fr: "Terminaux", de: "Terminals", th: "เทอร์มินัล" },
  "tab.title.files": { es: "Archivos", fr: "Fichiers", de: "Dateien", th: "ไฟล์" },
  "tab.title.directories": { es: "Directorios", fr: "Répertoires", de: "Verzeichnisse", th: "ไดเรกทอรี" },
  "tab.title.browser": { es: "Navegador", fr: "Navigateur", de: "Browser", th: "เบราว์เซอร์" },
  "tab.title.hardware": { es: "Hardware", fr: "Matériel", de: "Hardware", th: "ฮาร์ดแวร์" },
  "tab.title.discipline": { es: "Disciplina", fr: "Discipline", de: "Disziplin", th: "วินัย" },
  "tab.title.setup": { es: "Configuración", fr: "Configuration", de: "Einrichtung", th: "การตั้งค่าเริ่มต้น" },
  "tab.title.credits": { es: "Créditos", fr: "Crédits", de: "Guthaben", th: "เครดิต" },
  "tab.title.budget": { es: "Presupuesto", fr: "Budget", de: "Budget", th: "งบประมาณ" },
  "tab.title.mobile": { es: "Móvil", fr: "Mobile", de: "Mobil", th: "มือถือ" },
  "tab.title.appearance": { es: "Apariencia", fr: "Apparence", de: "Erscheinungsbild", th: "รูปลักษณ์" },
  "tab.title.config": { es: "Config", fr: "Config", de: "Konfig", th: "คอนฟิก" },
  "tab.title.apikeys": { es: "Claves API", fr: "Clés API", de: "API-Schlüssel", th: "คีย์ API" },
  "tab.title.channels": { es: "Canales", fr: "Canaux", de: "Kanäle", th: "ช่องทาง" },
  "tab.title.federation": { es: "Federación", fr: "Fédération", de: "Föderation", th: "เฟเดอเรชัน" },
  "tab.title.docs": { es: "Documentación", fr: "Documentation", de: "Dokumentation", th: "เอกสาร" },
  "tab.title.debug": { es: "Depuración", fr: "Débogage", de: "Debug", th: "ดีบัก" },
  "tab.title.logs": { es: "Registros", fr: "Journaux", de: "Protokolle", th: "บันทึกระบบ" },
  "tab.title.vcs": { es: "Control de versiones", fr: "Contrôle de version", de: "Versionskontrolle", th: "การควบคุมเวอร์ชัน" },
  "tab.title.wallet": { es: "Cartera", fr: "Portefeuille", de: "Wallet", th: "กระเป๋าเงิน" },
  "tab.title.trading": { es: "Terminal de trading", fr: "Terminal de trading", de: "Trading-Terminal", th: "เทอร์มินัลเทรด" },
  "tab.title.moltbook": { es: "Moltbook", fr: "Moltbook", de: "Moltbook", th: "Moltbook" },
  "tab.title.sites": { es: "Sitios", fr: "Sites", de: "Websites", th: "เว็บไซต์" },
  "tab.title.apps": { es: "Apps y sitios", fr: "Apps et sites", de: "Apps & Websites", th: "แอปและเว็บไซต์" },
  "tab.title.users": { es: "Usuarios", fr: "Utilisateurs", de: "Benutzer", th: "ผู้ใช้" },
  "tab.title.learn": { es: "Aprender", fr: "Apprendre", de: "Lernen", th: "เรียนรู้" },

  // ── Tab subtitles (en lives in subtitleForTab; only non-en needed) ─────
  "tab.subtitle.overview": {
    es: "Estado del gateway, puntos de entrada y una lectura rápida de salud.",
    fr: "État de la passerelle, points d'entrée et aperçu rapide de la santé.",
    de: "Gateway-Status, Einstiegspunkte und ein schneller Zustandsüberblick.",
    th: "สถานะเกตเวย์ จุดเข้าใช้งาน และภาพรวมสุขภาพอย่างรวดเร็ว",
  },
  "tab.subtitle.channels": {
    es: "Gestiona canales y ajustes.",
    fr: "Gérer les canaux et les paramètres.",
    de: "Kanäle und Einstellungen verwalten.",
    th: "จัดการช่องทางและการตั้งค่า",
  },
  "tab.subtitle.instances": {
    es: "Señales de presencia de clientes y nodos conectados.",
    fr: "Balises de présence des clients et nœuds connectés.",
    de: "Präsenzsignale von verbundenen Clients und Knoten.",
    th: "สัญญาณการมีอยู่ของไคลเอนต์และโหนดที่เชื่อมต่อ",
  },
  "tab.subtitle.sessions": {
    es: "Monitorea agentes activos, tareas concurrentes y carga de trabajo en tiempo real.",
    fr: "Surveillez les agents actifs, les tâches simultanées et la charge en temps réel.",
    de: "Aktive Agenten, gleichzeitige Aufgaben und Echtzeit-Auslastung überwachen.",
    th: "ติดตามเอเจนต์ที่ทำงานอยู่ งานที่ทำพร้อมกัน และภาระงานแบบเรียลไทม์",
  },
  "tab.subtitle.cron": {
    es: "Programa activaciones y ejecuciones recurrentes de agentes.",
    fr: "Planifiez des réveils et des exécutions d'agents récurrentes.",
    de: "Planen Sie Weckrufe und wiederkehrende Agentenläufe.",
    th: "กำหนดเวลาปลุกและการรันเอเจนต์ที่เกิดซ้ำ",
  },
  "tab.subtitle.schedule": {
    es: "Integración con Google Calendar — consulta reuniones y eventos y gestiona tu agenda con herramientas MCP.",
    fr: "Intégration Google Calendar — consultez réunions et événements et gérez votre agenda avec les outils MCP.",
    de: "Google-Kalender-Integration — Meetings und Termine ansehen und Ihren Zeitplan mit MCP-Tools verwalten.",
    th: "การเชื่อมต่อ Google Calendar — ดูการประชุมและกิจกรรม และจัดการตารางเวลาด้วยเครื่องมือ MCP",
  },
  "tab.subtitle.projects": {
    es: "Proyectos y bases de datos — tablero Kanban + bases de datos estilo Notion con registro por rol del sistema.",
    fr: "Projets et bases de données — tableau Kanban + bases de données façon Notion avec registre par rôle système.",
    de: "Projekte und Datenbanken — Kanban-Board + Notion-artige Datenbanken mit Systemrollen-Registry.",
    th: "โปรเจกต์และฐานข้อมูล — บอร์ด Kanban + ฐานข้อมูลสไตล์ Notion พร้อมรีจิสทรีตามบทบาทระบบ",
  },
  "tab.subtitle.agents": {
    es: "Crea y gestiona agentes de IA y subagentes.",
    fr: "Créez et gérez des agents IA et des sous-agents.",
    de: "KI-Agenten und Unteragenten erstellen und verwalten.",
    th: "สร้างและจัดการเอเจนต์ AI และซับเอเจนต์",
  },
  "tab.subtitle.mesh": {
    es: "Mapa isométrico en vivo de cada agente, subagente y sesión en la malla.",
    fr: "Carte isométrique en direct de chaque agent, sous-agent et session du maillage.",
    de: "Isometrische Live-Karte aller Agenten, Unteragenten und Sitzungen im Mesh.",
    th: "แผนที่ไอโซเมตริกแบบสดของเอเจนต์ ซับเอเจนต์ และเซสชันทั้งหมดในเครือข่าย",
  },
  "tab.subtitle.activity": {
    es: "Monitoreo en tiempo real de todos los agentes y subagentes en ejecución y su razonamiento.",
    fr: "Surveillance en temps réel de tous les agents et sous-agents actifs et de leur raisonnement.",
    de: "Echtzeitüberwachung aller laufenden Agenten und Unteragenten und ihrer Gedankengänge.",
    th: "การติดตามแบบเรียลไทม์ของเอเจนต์และซับเอเจนต์ที่ทำงานอยู่ทั้งหมดและกระบวนการคิด",
  },
  "tab.subtitle.subagents": {
    es: "Monitoreo integral de subagentes — estado en tiempo real, transcripciones, interacción y control.",
    fr: "Surveillance complète des sous-agents — état en temps réel, transcriptions, interaction et contrôle.",
    de: "Umfassende Unteragenten-Überwachung — Echtzeitstatus, Transkripte, Interaktion und Steuerung.",
    th: "การติดตามซับเอเจนต์อย่างครบถ้วน — สถานะเรียลไทม์ บันทึกการสนทนา การโต้ตอบ และการควบคุม",
  },
  "tab.subtitle.autonomy": {
    es: "Infraestructura de confianza — registro de auditoría, cola de tareas, control de pausa, monitoreo de API y detección de interferencias.",
    fr: "Infrastructure de confiance — journal d'audit, file de tâches, contrôle de pause, surveillance API et détection d'interférences.",
    de: "Vertrauensinfrastruktur — Audit-Protokoll, Aufgabenwarteschlange, Pausensteuerung, API-Überwachung und Störungserkennung.",
    th: "โครงสร้างความเชื่อถือ — บันทึกการตรวจสอบ คิวงาน การควบคุมการหยุดชั่วคราว การตรวจสอบ API และการตรวจจับการรบกวน",
  },
  "tab.subtitle.memory": {
    es: "Arquitectura de memoria profunda — identidad, creencias, valores, relaciones y búsqueda de memoria semántica.",
    fr: "Architecture de mémoire profonde — identité, croyances, valeurs, relations et recherche de mémoire sémantique.",
    de: "Tiefe Speicherarchitektur — Identität, Überzeugungen, Werte, Beziehungen und semantische Speichersuche.",
    th: "สถาปัตยกรรมหน่วยความจำเชิงลึก — อัตลักษณ์ ความเชื่อ ค่านิยม ความสัมพันธ์ และการค้นหาหน่วยความจำเชิงความหมาย",
  },
  "tab.subtitle.workflows": {
    es: "Crea y gestiona flujos de trabajo de instrucciones markdown reutilizables.",
    fr: "Créez et gérez des flux de travail d'instructions markdown réutilisables.",
    de: "Wiederverwendbare Markdown-Anweisungs-Workflows erstellen und verwalten.",
    th: "สร้างและจัดการเวิร์กโฟลว์คำสั่ง markdown ที่ใช้ซ้ำได้",
  },
  "tab.subtitle.skills": {
    es: "Gestiona la disponibilidad de habilidades y la inyección de claves API.",
    fr: "Gérez la disponibilité des compétences et l'injection de clés API.",
    de: "Verfügbarkeit von Fähigkeiten und API-Schlüssel-Injektion verwalten.",
    th: "จัดการความพร้อมใช้งานของทักษะและการแทรกคีย์ API",
  },
  "skills.discover.title": {
    es: "Descubrir habilidades", fr: "Découvrir les compétences", de: "Fähigkeiten entdecken", th: "ค้นพบทักษะ",
  },
  "skills.discover.subtitle": {
    es: "Explora, instala y gestiona habilidades — dale nuevas capacidades a tus agentes en un clic.",
    fr: "Parcourez, installez et gérez des compétences — donnez de nouvelles capacités à vos agents en un clic.",
    de: "Fähigkeiten durchsuchen, installieren und verwalten — gib deinen Agenten mit einem Klick neue Fähigkeiten.",
    th: "เรียกดู ติดตั้ง และจัดการทักษะ — เพิ่มความสามารถใหม่ให้เอเจนต์ในคลิกเดียว",
  },
  "skills.discover.search": {
    es: "Buscar habilidades por nombre, descripción o requisito…",
    fr: "Rechercher des compétences par nom, description ou prérequis…",
    de: "Fähigkeiten nach Name, Beschreibung oder Anforderung suchen…",
    th: "ค้นหาทักษะตามชื่อ คำอธิบาย หรือข้อกำหนด…",
  },
  "skills.discover.featured": { es: "Destacadas", fr: "En vedette", de: "Empfohlen", th: "แนะนำ" },
  "skills.discover.all": { es: "Todas las habilidades", fr: "Toutes les compétences", de: "Alle Fähigkeiten", th: "ทักษะทั้งหมด" },
  "skills.author.new": { es: "Crear habilidad", fr: "Créer une compétence", de: "Fähigkeit erstellen", th: "สร้างทักษะ" },
  "skills.card.install": { es: "Instalar", fr: "Installer", de: "Installieren", th: "ติดตั้ง" },
  "skills.card.enable": { es: "Activar", fr: "Activer", de: "Aktivieren", th: "เปิดใช้งาน" },
  "skills.card.disable": { es: "Desactivar", fr: "Désactiver", de: "Deaktivieren", th: "ปิดใช้งาน" },
  "tab.subtitle.nodes": {
    es: "Dispositivos emparejados, capacidades y exposición de comandos.",
    fr: "Appareils appairés, capacités et exposition des commandes.",
    de: "Gekoppelte Geräte, Funktionen und Befehlsfreigabe.",
    th: "อุปกรณ์ที่จับคู่ ความสามารถ และการเปิดเผยคำสั่ง",
  },
  "tab.subtitle.chat": {
    es: "Sesión de chat directa con el gateway para intervenciones rápidas.",
    fr: "Session de chat directe avec la passerelle pour des interventions rapides.",
    de: "Direkte Chat-Sitzung mit dem Gateway für schnelle Eingriffe.",
    th: "เซสชันแชทโดยตรงกับเกตเวย์สำหรับการแทรกแซงอย่างรวดเร็ว",
  },
  "tab.subtitle.grid": {
    es: "Cuadrícula de chat multisesión arrastrable y redimensionable para conversaciones en paralelo.",
    fr: "Grille de chat multisession déplaçable et redimensionnable pour des conversations en parallèle.",
    de: "Verschiebbares, größenveränderbares Multi-Session-Chat-Raster für parallele Gespräche.",
    th: "กริดแชทหลายเซสชันที่ลากและปรับขนาดได้สำหรับการสนทนาแบบขนาน",
  },
  "tab.subtitle.voice": {
    es: "Interacción de voz en tiempo real con tu agente.",
    fr: "Interaction vocale en temps réel avec votre agent.",
    de: "Echtzeit-Sprachinteraktion mit Ihrem Agenten.",
    th: "การโต้ตอบด้วยเสียงแบบเรียลไทม์กับเอเจนต์ของคุณ",
  },
  "tab.subtitle.voicecommands": {
    es: "Gestiona palabras de activación, disparadores de voz y vínculos de voz de flujos de trabajo.",
    fr: "Gérez les mots d'activation, les déclencheurs vocaux et les liaisons vocales des flux de travail.",
    de: "Aktivierungswörter, Sprachauslöser und Sprachbindungen von Workflows verwalten.",
    th: "จัดการคำปลุก ทริกเกอร์เสียง และการผูกเสียงของเวิร์กโฟลว์",
  },
  "tab.subtitle.video": {
    es: "Generación de vídeo con IA con selección de personajes, modelos Replicate y entrega por Telegram.",
    fr: "Génération de vidéo par IA avec sélection de personnages, modèles Replicate et livraison Telegram.",
    de: "KI-gestützte Videogenerierung mit Charakterauswahl, Replicate-Modellen und Telegram-Zustellung.",
    th: "การสร้างวิดีโอด้วย AI พร้อมการเลือกตัวละคร โมเดล Replicate และการส่งผ่าน Telegram",
  },
  "tab.subtitle.config": {
    es: "Edita ~/.infinibot/infinibot.json de forma segura.",
    fr: "Modifiez ~/.infinibot/infinibot.json en toute sécurité.",
    de: "Bearbeiten Sie ~/.infinibot/infinibot.json sicher.",
    th: "แก้ไข ~/.infinibot/infinibot.json อย่างปลอดภัย",
  },
  "tab.subtitle.apikeys": {
    es: "Gestiona claves API para proveedores de IA, servicios e integraciones.",
    fr: "Gérez les clés API pour les fournisseurs d'IA, les services et les intégrations.",
    de: "API-Schlüssel für KI-Anbieter, Dienste und Integrationen verwalten.",
    th: "จัดการคีย์ API สำหรับผู้ให้บริการ AI บริการ และการเชื่อมต่อ",
  },
  "tab.subtitle.debug": {
    es: "Instantáneas del gateway, eventos y llamadas RPC manuales.",
    fr: "Instantanés de la passerelle, événements et appels RPC manuels.",
    de: "Gateway-Snapshots, Ereignisse und manuelle RPC-Aufrufe.",
    th: "สแนปช็อตเกตเวย์ เหตุการณ์ และการเรียก RPC ด้วยตนเอง",
  },
  "tab.subtitle.logs": {
    es: "Seguimiento en vivo de los registros del gateway.",
    fr: "Suivi en direct des journaux de la passerelle.",
    de: "Live-Verfolgung der Gateway-Protokolldateien.",
    th: "ติดตามไฟล์บันทึกของเกตเวย์แบบสด",
  },
  "tab.subtitle.mcp": {
    es: "Estado de servidores MCP, configuración de herramientas de agentes y gestión de servidores.",
    fr: "État des serveurs MCP, configuration des outils d'agents et gestion des serveurs.",
    de: "MCP-Serverstatus, Agenten-Tool-Konfiguration und Serververwaltung.",
    th: "สถานะเซิร์ฟเวอร์ MCP การกำหนดค่าเครื่องมือเอเจนต์ และการจัดการเซิร์ฟเวอร์",
  },
  "tab.subtitle.notes": {
    es: "Crea y gestiona notas en markdown, ideas y capturas rápidas.",
    fr: "Créez et gérez des notes markdown, des idées et des captures rapides.",
    de: "Markdown-Notizen, Gedanken und Schnellnotizen erstellen und verwalten.",
    th: "สร้างและจัดการบันทึก markdown ความคิด และการจดอย่างรวดเร็ว",
  },
  "tab.subtitle.research": {
    es: "Inteligencia automatizada de noticias y finanzas — temas, listas de seguimiento, análisis de sentimiento y sincronización con Notion.",
    fr: "Veille automatisée actualités et finance — sujets, listes de suivi, analyse de sentiment et synchronisation Notion.",
    de: "Automatisierte Nachrichten- und Finanzanalyse — Themen, Beobachtungslisten, Stimmungsanalyse und Notion-Sync.",
    th: "ระบบข่าวกรองข่าวและการเงินอัตโนมัติ — หัวข้อ รายการเฝ้าดู การวิเคราะห์อารมณ์ และการซิงค์กับ Notion",
  },
  "tab.subtitle.terminals": {
    es: "Gestión de sesiones multiterminal con integración de agentes CLI.",
    fr: "Gestion de sessions multi-terminaux avec intégration d'agents CLI.",
    de: "Multi-Terminal-Sitzungsverwaltung mit CLI-Agenten-Integration.",
    th: "การจัดการเซสชันหลายเทอร์มินัลพร้อมการผสานเอเจนต์ CLI",
  },
  "tab.subtitle.business": {
    es: "Configuración del perfil de negocio e integración con bases de datos de Notion.",
    fr: "Configuration du profil d'entreprise et intégration avec les bases de données Notion.",
    de: "Einrichtung des Geschäftsprofils und Integration mit Notion-Datenbanken.",
    th: "การตั้งค่าโปรไฟล์ธุรกิจและการผสานกับฐานข้อมูล Notion",
  },
  "tab.subtitle.clients": {
    es: "CRM de gestión de clientes con sincronización de Notion — vistas de cuadrícula, tabla y kanban.",
    fr: "CRM de gestion des clients avec synchronisation Notion — vues grille, tableau et kanban.",
    de: "Kundenverwaltungs-CRM mit Notion-Sync — Raster-, Tabellen- und Kanban-Ansichten.",
    th: "CRM จัดการลูกค้าพร้อมการซิงค์ Notion — มุมมองกริด ตาราง และ kanban",
  },
  "tab.subtitle.leads": {
    es: "Panel de prospectos unificado — Generación · Calificación · Pipeline · Cronología en una sola página.",
    fr: "Tableau des prospects unifié — Génération · Qualification · Pipeline · Chronologie sur une seule page.",
    de: "Einheitliches Lead-Dashboard — Generierung · Qualifizierung · Pipeline · Zeitleiste auf einer Seite.",
    th: "แดชบอร์ดลูกค้าเป้าหมายแบบรวม — การสร้าง · การคัดกรอง · ไปป์ไลน์ · ไทม์ไลน์ ในหน้าเดียว",
  },
  "tab.subtitle.qualifier": {
    es: "Panel de prospectos unificado — sección de calificación: criterios de webhook, pila de acciones, enrutamiento.",
    fr: "Tableau des prospects unifié — section qualification : critères de webhook, pile d'actions, routage.",
    de: "Einheitliches Lead-Dashboard — Qualifizierungsbereich: Webhook-Kriterien, Aktionsstapel, Routing.",
    th: "แดชบอร์ดลูกค้าเป้าหมายแบบรวม — ส่วนการคัดกรอง: เกณฑ์ webhook สแต็กการกระทำ การกำหนดเส้นทาง",
  },
  "tab.subtitle.pipeline": {
    es: "Panel de prospectos unificado — sección pipeline: kanban agrupado por etapa o temperatura.",
    fr: "Tableau des prospects unifié — section pipeline : kanban groupé par étape ou température.",
    de: "Einheitliches Lead-Dashboard — Pipeline-Bereich: Kanban gruppiert nach Phase oder Temperatur.",
    th: "แดชบอร์ดลูกค้าเป้าหมายแบบรวม — ส่วนไปป์ไลน์: kanban จัดกลุ่มตามขั้นตอนหรืออุณหภูมิ",
  },
  "tab.subtitle.funnels": {
    es: "Constructor visual de embudos — mapea recorridos de clientes, sigue KPIs y automatiza flujos de venta.",
    fr: "Constructeur visuel d'entonnoirs — cartographiez les parcours clients, suivez les KPI et automatisez les ventes.",
    de: "Visueller Trichter-Builder — Kundenreisen abbilden, KPIs verfolgen und Verkaufsabläufe automatisieren.",
    th: "เครื่องมือสร้างฟันเนลแบบภาพ — วางแผนเส้นทางลูกค้า ติดตาม KPI และทำให้ขั้นตอนการขายเป็นอัตโนมัติ",
  },
  "tab.subtitle.databases": {
    es: "Conecta cualquier base de datos de Notion — detecta el esquema y gestiona páginas con vistas de cuadrícula, tabla y kanban.",
    fr: "Connectez n'importe quelle base Notion — détection du schéma et gestion des pages en vues grille, tableau et kanban.",
    de: "Verbinden Sie jede Notion-Datenbank — Schema automatisch erkennen, Seiten in Raster-, Tabellen- und Kanban-Ansichten verwalten.",
    th: "เชื่อมต่อฐานข้อมูล Notion ใดก็ได้ — ตรวจจับสคีมาและจัดการหน้าด้วยมุมมองกริด ตาราง และ kanban",
  },
  "tab.subtitle.messages": {
    es: "Centro de comunicación entre agentes — consulta y envía mensajes entre sesiones.",
    fr: "Hub de communication inter-agents — consultez et envoyez des messages entre sessions.",
    de: "Kommunikationszentrum zwischen Agenten — Nachrichten sitzungsübergreifend ansehen und senden.",
    th: "ศูนย์กลางการสื่อสารระหว่างเอเจนต์ — ดูและส่งข้อความข้ามเซสชัน",
  },
  "tab.subtitle.budget": {
    es: "Seguimiento del presupuesto de uso de API, enrutamiento inteligente de delegación y gestión de suscripciones de proveedores.",
    fr: "Suivi du budget d'utilisation API, routage intelligent de délégation et gestion des abonnements fournisseurs.",
    de: "Verfolgung des API-Nutzungsbudgets, intelligentes Delegations-Routing und Verwaltung von Anbieter-Abonnements.",
    th: "ติดตามงบประมาณการใช้ API การกำหนดเส้นทางการมอบหมายอัจฉริยะ และการจัดการการสมัครสมาชิกผู้ให้บริการ",
  },
  "tab.subtitle.credits": {
    es: "Libro de créditos unificado — gasto en tokens y USD en cada proveedor, backend de agente y CLI que ejecutamos.",
    fr: "Registre de crédits unifié — dépenses en tokens et USD pour chaque fournisseur, backend d'agent et CLI lancé.",
    de: "Einheitliches Guthabenbuch — Token- und USD-Ausgaben über jeden Anbieter, jedes Agenten-Backend und jede CLI.",
    th: "สมุดเครดิตแบบรวม — การใช้จ่ายโทเค็นและ USD ของผู้ให้บริการ แบ็กเอนด์เอเจนต์ และ CLI ทุกตัวที่เรารัน",
  },
  "tab.subtitle.vcs": {
    es: "Gestión de árboles de trabajo de tareas — revisa, aprueba y revierte cambios entre espacios de trabajo.",
    fr: "Gestion des arbres de travail des tâches — examinez, approuvez et annulez les modifications entre espaces de travail.",
    de: "Verwaltung von Aufgaben-Worktrees — Änderungen über Arbeitsbereiche hinweg prüfen, genehmigen und zurücksetzen.",
    th: "การจัดการ worktree ของงาน — ตรวจสอบ อนุมัติ และย้อนกลับการเปลี่ยนแปลงข้ามพื้นที่ทำงาน",
  },
  "tab.subtitle.files": {
    es: "Explora, sube y gestiona archivos en el espacio de trabajo de InfiniBot con vista de árbol y previsualización.",
    fr: "Parcourez, téléversez et gérez les fichiers de l'espace InfiniBot avec arborescence et aperçu.",
    de: "Dateien im InfiniBot-Arbeitsbereich durchsuchen, hochladen und verwalten — mit Baumansicht und Vorschau.",
    th: "เรียกดู อัปโหลด และจัดการไฟล์ในพื้นที่ทำงาน InfiniBot ด้วยมุมมองต้นไม้และตัวอย่าง",
  },
  "tab.subtitle.directories": {
    es: "Asigna directorios locales a proyectos, bases de datos de Notion y agentes para inyección automática de contexto.",
    fr: "Associez des répertoires locaux à des projets, bases Notion et agents pour l'injection automatique de contexte.",
    de: "Lokale Verzeichnisse Projekten, Notion-Datenbanken und Agenten zuordnen für automatische Kontextinjektion.",
    th: "แมปไดเรกทอรีในเครื่องไปยังโปรเจกต์ ฐานข้อมูล Notion และเอเจนต์เพื่อแทรกบริบทอัตโนมัติ",
  },
  "tab.subtitle.moltbook": {
    es: "Red social de agentes de IA — publica, comenta, vota, envía mensajes y gestiona tu presencia en Moltbook.",
    fr: "Réseau social d'agents IA — publiez, commentez, votez, envoyez des messages et gérez votre présence Moltbook.",
    de: "Soziales Netzwerk für KI-Agenten — posten, kommentieren, abstimmen, Nachrichten senden und Ihre Moltbook-Präsenz verwalten.",
    th: "เครือข่ายสังคมของเอเจนต์ AI — โพสต์ แสดงความคิดเห็น โหวต ส่งข้อความ และจัดการตัวตน Moltbook ของคุณ",
  },
  "tab.subtitle.whiteboard": {
    es: "Pizarra basada en Excalidraw para pensamiento visual, diagramas y bocetos colaborativos.",
    fr: "Tableau blanc basé sur Excalidraw pour la réflexion visuelle, les diagrammes et le croquis collaboratif.",
    de: "Excalidraw-basiertes Whiteboard für visuelles Denken, Diagramme und gemeinsames Skizzieren.",
    th: "ไวต์บอร์ดบน Excalidraw สำหรับการคิดเชิงภาพ ไดอะแกรม และการร่างร่วมกัน",
  },
  "tab.subtitle.browser": {
    es: "Navegador Chromium integrado con cookies persistentes y contexto de sesión para automatización web.",
    fr: "Navigateur Chromium intégré avec cookies persistants et contexte de session pour l'automatisation web.",
    de: "Eingebetteter Chromium-Browser mit persistenten Cookies und Sitzungskontext für Web-Automatisierung.",
    th: "เบราว์เซอร์ Chromium ในตัวพร้อมคุกกี้ถาวรและบริบทเซสชันสำหรับการทำงานเว็บอัตโนมัติ",
  },
  "tab.subtitle.setup": {
    es: "Integración MCP, despliegue Docker, asistente de configuración y gestión de instancias.",
    fr: "Intégration MCP, déploiement Docker, assistant de configuration et gestion des instances.",
    de: "MCP-Integration, Docker-Bereitstellung, Einrichtungsassistent und Instanzkonfigurationsverwaltung.",
    th: "การผสาน MCP การปรับใช้ Docker ตัวช่วยตั้งค่า และการจัดการอินสแตนซ์",
  },
  "tab.subtitle.federation": {
    es: "Configuración de red multinodo — conecta satélites, gestiona nodos y enruta el cómputo.",
    fr: "Configuration réseau multi-nœuds — connectez des satellites, gérez les nœuds et routez le calcul.",
    de: "Mehrknoten-Netzwerkkonfiguration — Satelliten verbinden, Knoten verwalten und Rechenlast verteilen.",
    th: "การกำหนดค่าเครือข่ายหลายโหนด — เชื่อมต่อดาวเทียม จัดการโหนด และกำหนดเส้นทางการประมวลผล",
  },
  "tab.subtitle.wallet": {
    es: "Gestión de cartera Solana — importa claves, consulta saldos y monitorea tenencias de tokens.",
    fr: "Gestion de portefeuille Solana — importez des clés, consultez les soldes et surveillez vos tokens.",
    de: "Solana-Wallet-Verwaltung — Schlüssel importieren, Guthaben ansehen und Token-Bestände überwachen.",
    th: "การจัดการกระเป๋าเงิน Solana — นำเข้าคีย์ ดูยอดคงเหลือ และติดตามการถือครองโทเค็น",
  },
  "tab.subtitle.trading": {
    es: "Terminal de trading de perps con IA — inteligencia de noticias, mercados de predicción, ejecución en Hyperliquid.",
    fr: "Terminal de trading de perps par IA — veille actualités, marchés de prédiction, exécution Hyperliquid.",
    de: "KI-gestütztes Perps-Trading-Terminal — Nachrichtenanalyse, Prognosemärkte, Hyperliquid-Ausführung.",
    th: "เทอร์มินัลเทรด perps ด้วย AI — ข่าวกรองข่าว ตลาดทำนาย การดำเนินการบน Hyperliquid",
  },
  "tab.subtitle.storyboard": {
    es: "Generación automatizada de guiones gráficos — escritura de guion, división de escenas y generación de imágenes con IA.",
    fr: "Génération automatisée de storyboards — écriture de scénario, découpage de scènes et génération d'images par IA.",
    de: "Automatisierte Storyboard-Generierung — Drehbuchschreiben, Szenenaufteilung und KI-Bildgenerierung.",
    th: "การสร้างสตอรีบอร์ดอัตโนมัติ — การเขียนบท การแบ่งฉาก และการสร้างภาพด้วย AI",
  },
  "tab.subtitle.discipline": {
    es: "Responsabilidad estricta con el tiempo — bloquea el día, registra la desviación, puntúa la racha.",
    fr: "Responsabilité stricte du temps — bloquez la journée, enregistrez la dérive, notez la série.",
    de: "Strikte Zeitdisziplin — den Tag blockieren, Abweichungen protokollieren, die Serie bewerten.",
    th: "ความรับผิดชอบต่อเวลาอย่างเข้มงวด — บล็อกวัน บันทึกการเบี่ยงเบน ให้คะแนนสตรีค",
  },
  "tab.subtitle.appearance": {
    es: "Tema, colores, intensidad del HUD de cristal, nombre de la app, logotipo.",
    fr: "Thème, couleurs, intensité du HUD en verre, nom de l'app, logo.",
    de: "Thema, Farben, Glas-HUD-Intensität, App-Name, Logo.",
    th: "ธีม สี ความเข้มของกระจก HUD ชื่อแอป โลโก้",
  },
  "tab.subtitle.sites": {
    es: "Páginas de aterrizaje de arrastrar y soltar — constructor de bloques, control de código con IA, alojamiento Netlify y captura CRM por negocio.",
    fr: "Pages d'atterrissage glisser-déposer — constructeur de blocs, contrôle de code IA, hébergement Netlify et capture CRM par entreprise.",
    de: "Drag-and-Drop-Landingpages — Block-Builder, KI-Code-Steuerung, Netlify-Hosting und CRM-Erfassung pro Unternehmen.",
    th: "หน้า Landing แบบลากและวาง — เครื่องมือสร้างบล็อก การควบคุมโค้ดด้วย AI โฮสติ้ง Netlify และการเก็บข้อมูล CRM ต่อธุรกิจ",
  },
  "tab.subtitle.workspace": {
    es: "IDE por proyecto — árbol de archivos, código/diff/vista previa, chat con Claude Coder — estilo Bolt con glassmorfismo HUD.",
    fr: "IDE par projet — arborescence, code/diff/aperçu, chat Claude Coder — style Bolt avec glassmorphisme HUD.",
    de: "IDE pro Projekt — Dateibaum, Code/Diff/Vorschau, Claude-Coder-Chat — im Bolt-Stil mit HUD-Glasmorphismus.",
    th: "IDE ต่อโปรเจกต์ — ต้นไม้ไฟล์ โค้ด/diff/ตัวอย่าง แชทกับ Claude Coder — สไตล์ Bolt พร้อม HUD กระจก",
  },
  "tab.subtitle.docs": {
    es: "Referencia detallada de cada función, comando, canal e integración.",
    fr: "Référence détaillée pour chaque fonctionnalité, commande, canal et intégration.",
    de: "Ausführliche Referenz für jede Funktion, jeden Befehl, jeden Kanal und jede Integration.",
    th: "เอกสารอ้างอิงโดยละเอียดสำหรับทุกฟีเจอร์ คำสั่ง ช่องทาง และการผสาน",
  },
  "tab.subtitle.inbox": {
    es: "Bandeja unificada — Todo el correo segmentado por cuenta, respuestas de prospectos clasificadas por IA e Insights con reglas de alerta de Telegram.",
    fr: "Boîte unifiée — Tous les e-mails segmentés par compte, réponses de prospects triées par IA et Insights avec règles d'alerte Telegram.",
    de: "Einheitlicher Posteingang — kontosegmentierte Gesamtpost, KI-sortierte Lead-Antworten und Insights mit Telegram-Alarmregeln.",
    th: "กล่องข้อความแบบรวม — อีเมลทั้งหมดแยกตามบัญชี การตอบกลับลูกค้าเป้าหมายที่จัดเรียงด้วย AI และ Insights พร้อมกฎแจ้งเตือน Telegram",
  },
  "tab.subtitle.email": {
    es: "Cuentas de Gmail conectadas — bandeja, resumen con IA, conmutador multicuenta y reglas de alerta de Telegram para correo importante.",
    fr: "Comptes Gmail connectés — boîte de réception, résumé IA, sélecteur multicompte et règles d'alerte Telegram pour le courrier important.",
    de: "Verbundene Gmail-Konten — Posteingang, KI-Zusammenfassung, Multikonto-Umschalter und Telegram-Alarmregeln für wichtige Post.",
    th: "บัญชี Gmail ที่เชื่อมต่อ — กล่องข้อความ สรุปด้วย AI ตัวสลับหลายบัญชี และกฎแจ้งเตือน Telegram สำหรับเมลสำคัญ",
  },
  "tab.subtitle.emails": {
    es: "Cuentas de Gmail conectadas — bandeja, resumen con IA, conmutador multicuenta y reglas de alerta de Telegram para correo importante.",
    fr: "Comptes Gmail connectés — boîte de réception, résumé IA, sélecteur multicompte et règles d'alerte Telegram pour le courrier important.",
    de: "Verbundene Gmail-Konten — Posteingang, KI-Zusammenfassung, Multikonto-Umschalter und Telegram-Alarmregeln für wichtige Post.",
    th: "บัญชี Gmail ที่เชื่อมต่อ — กล่องข้อความ สรุปด้วย AI ตัวสลับหลายบัญชี และกฎแจ้งเตือน Telegram สำหรับเมลสำคัญ",
  },
  "tab.subtitle.products": {
    es: "Catálogo de productos digitales y físicos con inventario, precios, variantes y sincronización con Notion.",
    fr: "Catalogue de produits numériques et physiques avec stock, prix, variantes et synchronisation Notion.",
    de: "Katalog digitaler und physischer Produkte mit Bestand, Preisen, Varianten und Notion-Sync.",
    th: "แคตตาล็อกสินค้าดิจิทัลและกายภาพพร้อมสินค้าคงคลัง ราคา ตัวเลือก และการซิงค์ Notion",
  },
  "tab.subtitle.design": {
    es: "Generación de diseño con IA — habilidades + sistemas de diseño + Claude Coder, con vista previa en iframe y artefactos por proyecto.",
    fr: "Génération de design par IA — compétences + systèmes de design + Claude Coder, avec aperçu iframe et artefacts par projet.",
    de: "KI-gesteuerte Designgenerierung — Fähigkeiten + Designsysteme + Claude Coder, mit Live-iframe-Vorschau und projektbezogenen Artefakten.",
    th: "การสร้างดีไซน์ด้วย AI — ทักษะ + ระบบดีไซน์ + Claude Coder พร้อมตัวอย่าง iframe สดและอาร์ติแฟกต์ต่อโปรเจกต์",
  },
  "tab.subtitle.hardware": {
    es: "HUD de análisis de hardware en tiempo real — CPU, GPU, RAM, disco y red en vivo con insights.",
    fr: "HUD d'analyse matérielle en temps réel — CPU, GPU, RAM, disque et réseau en direct avec insights.",
    de: "Echtzeit-Hardware-Analyse-HUD — Live-CPU, -GPU, -RAM, -Festplatte und -Netzwerk mit Erkenntnissen.",
    th: "HUD วิเคราะห์ฮาร์ดแวร์แบบเรียลไทม์ — CPU, GPU, RAM, ดิสก์ และเครือข่ายแบบสดพร้อมข้อมูลเชิงลึก",
  },
  "tab.subtitle.campaigns": {
    es: "Campañas de difusión — KPIs de embudo, gestión de plantillas, variantes A/B y seguimiento de conversiones.",
    fr: "Campagnes de prospection — KPI d'entonnoir, gestion de modèles, variantes A/B et suivi des conversions.",
    de: "Outreach-Kampagnen — Trichter-KPIs, Vorlagenverwaltung, A/B-Varianten und Conversion-Tracking.",
    th: "แคมเปญเอาท์รีช — KPI ฟันเนล การจัดการเทมเพลต ตัวแปร A/B และการติดตามคอนเวอร์ชัน",
  },
  "tab.subtitle.reply-inbox": {
    es: "Triaje de respuestas — respuestas clasificadas por IA y ordenadas por urgencia con acciones sugeridas y marcado en un clic.",
    fr: "Tri des réponses — réponses classées par IA et triées par urgence avec actions suggérées et marquage en un clic.",
    de: "Antwort-Triage — KI-klassifizierte Antworten nach Dringlichkeit sortiert, mit Aktionsvorschlägen und Ein-Klick-Erledigung.",
    th: "การคัดกรองการตอบกลับ — การตอบกลับที่จัดประเภทด้วย AI เรียงตามความเร่งด่วนพร้อมการกระทำที่แนะนำและการทำเครื่องหมายคลิกเดียว",
  },
  "tab.subtitle.content-pages": {
    es: "Superficies de contenido por negocio — Guiones, Vídeos, Contenido, Ideas, analítica profunda y conexiones con campañas, productos y embudos.",
    fr: "Surfaces de contenu par entreprise — Scripts, Vidéos, Contenu, Idées, analytique approfondie et liens vers campagnes, produits, entonnoirs.",
    de: "Inhaltsflächen pro Unternehmen — Skripte, Videos, Inhalte, Ideen, tiefe Analysen und Verbindungen zu Kampagnen, Produkten, Trichtern.",
    th: "พื้นที่เนื้อหาต่อธุรกิจ — บท วิดีโอ เนื้อหา ไอเดีย การวิเคราะห์เชิงลึก และการเชื่อมต่อกับแคมเปญ สินค้า และฟันเนล",
  },
  "tab.subtitle.prompt-templates": {
    es: "Plantillas de instrucciones reutilizables — escríbelas una vez y aplica un estilo o flujo de trabajo coherente a cualquier agente.",
    fr: "Modèles d'instructions réutilisables — rédigez une fois et appliquez un style ou flux cohérent à n'importe quel agent.",
    de: "Wiederverwendbare Anweisungsvorlagen — einmal verfassen und jedem Agenten einen einheitlichen Stil oder Workflow zuweisen.",
    th: "เทมเพลตคำสั่งที่ใช้ซ้ำได้ — เขียนครั้งเดียวและใช้สไตล์หรือเวิร์กโฟลว์ที่สอดคล้องกับเอเจนต์ใดก็ได้",
  },
  "tab.subtitle.dashboard": {
    es: "Tu centro de aprendizaje personal — sigue tu progreso, continúa cursos y controla tus logros.",
    fr: "Votre hub d'apprentissage personnel — suivez vos progrès, continuez les cours et surveillez vos réussites.",
    de: "Ihr persönlicher Lern-Hub — Fortschritt verfolgen, Kurse fortsetzen und Erfolge überwachen.",
    th: "ศูนย์การเรียนรู้ส่วนตัวของคุณ — ติดตามความก้าวหน้า เรียนต่อ และตรวจสอบความสำเร็จ",
  },

  // ── Notes view (page body — keyed to the real source literals) ────────
  "notes.search": { en: "SEARCH NOTES...", es: "BUSCAR NOTAS...", fr: "RECHERCHER DES NOTES...", de: "NOTIZEN SUCHEN...", th: "ค้นหาบันทึก..." },
  "notes.new": { en: "+ NEW", es: "+ NUEVA", fr: "+ NOUVELLE", de: "+ NEU", th: "+ ใหม่" },
  "notes.pullNotion": { en: "Pull from Notion", es: "Importar de Notion", fr: "Importer depuis Notion", de: "Aus Notion abrufen", th: "ดึงจาก Notion" },
  "notes.allCategories": { en: "ALL CATEGORIES", es: "TODAS LAS CATEGORÍAS", fr: "TOUTES LES CATÉGORIES", de: "ALLE KATEGORIEN", th: "ทุกหมวดหมู่" },
  "notes.allProjects": { en: "ALL PROJECTS", es: "TODOS LOS PROYECTOS", fr: "TOUS LES PROJETS", de: "ALLE PROJEKTE", th: "ทุกโปรเจกต์" },
  "notes.selectOrCreate": { en: "Select a note or create a new one", es: "Selecciona una nota o crea una nueva", fr: "Sélectionnez une note ou créez-en une nouvelle", de: "Wählen Sie eine Notiz oder erstellen Sie eine neue", th: "เลือกบันทึกหรือสร้างใหม่" },
  "notes.bodyPlaceholder": { en: "Write your note in Markdown...", es: "Escribe tu nota en Markdown...", fr: "Rédigez votre note en Markdown...", de: "Schreiben Sie Ihre Notiz in Markdown...", th: "เขียนบันทึกของคุณด้วย Markdown..." },
  "notes.unsaved": { en: "UNSAVED", es: "SIN GUARDAR", fr: "NON ENREGISTRÉ", de: "NICHT GESPEICHERT", th: "ยังไม่บันทึก" },
  "notes.exportFormat": { en: "Export Format", es: "Formato de exportación", fr: "Format d'exportation", de: "Exportformat", th: "รูปแบบการส่งออก" },
  "notes.style": { en: "Style", es: "Estilo", fr: "Style", de: "Stil", th: "สไตล์" },
  "notes.discard": { en: "DISCARD", es: "DESCARTAR", fr: "ABANDONNER", de: "VERWERFEN", th: "ละทิ้ง" },
  "notes.name": { en: "NAME", es: "NOMBRE", fr: "NOM", de: "NAME", th: "ชื่อ" },
  "notes.description": { en: "DESCRIPTION", es: "DESCRIPCIÓN", fr: "DESCRIPTION", de: "BESCHREIBUNG", th: "คำอธิบาย" },
  "notes.category": { en: "CATEGORY", es: "CATEGORÍA", fr: "CATÉGORIE", de: "KATEGORIE", th: "หมวดหมู่" },
  "notes.tags": { en: "TAGS", es: "ETIQUETAS", fr: "ÉTIQUETTES", de: "TAGS", th: "แท็ก" },
  "notes.namePlaceholder": { en: "Note name", es: "Nombre de la nota", fr: "Nom de la note", de: "Notizname", th: "ชื่อบันทึก" },
  "notes.descPlaceholder": { en: "Short description", es: "Descripción breve", fr: "Brève description", de: "Kurzbeschreibung", th: "คำอธิบายสั้นๆ" },
  "notes.markdown": { en: "MARKDOWN", es: "MARKDOWN", fr: "MARKDOWN", de: "MARKDOWN", th: "MARKDOWN" },
  "notes.ctrlSave": { en: "CTRL+S TO SAVE", es: "CTRL+S PARA GUARDAR", fr: "CTRL+S POUR ENREGISTRER", de: "STRG+S ZUM SPEICHERN", th: "CTRL+S เพื่อบันทึก" },
  "notes.save": { en: "💾 SAVE", es: "💾 GUARDAR", fr: "💾 ENREGISTRER", de: "💾 SPEICHERN", th: "💾 บันทึก" },
  "notes.saving": { en: "SAVING...", es: "GUARDANDO...", fr: "ENREGISTREMENT...", de: "WIRD GESPEICHERT...", th: "กำลังบันทึก..." },
  "notes.pinned": { en: "📌 PINNED", es: "📌 FIJADA", fr: "📌 ÉPINGLÉE", de: "📌 ANGEHEFTET", th: "📌 ปักหมุด" },
  "notes.project": { en: "🔗 PROJECT", es: "🔗 PROYECTO", fr: "🔗 PROJET", de: "🔗 PROJEKT", th: "🔗 โปรเจกต์" },
  "notes.categoryPlaceholder": { en: "e.g. ideas, logs", es: "p. ej. ideas, registros", fr: "p. ex. idées, journaux", de: "z. B. Ideen, Protokolle", th: "เช่น ไอเดีย บันทึก" },
  "notes.tagsPlaceholder": { en: "tag1, tag2", es: "etiqueta1, etiqueta2", fr: "tag1, tag2", de: "Tag1, Tag2", th: "แท็ก1, แท็ก2" },
  "notes.linkedPlaceholder": { en: "Linked note IDs (comma-separated)", es: "IDs de notas vinculadas (separados por comas)", fr: "ID de notes liées (séparés par des virgules)", de: "Verknüpfte Notiz-IDs (kommagetrennt)", th: "ID บันทึกที่เชื่อมโยง (คั่นด้วยจุลภาค)" },
  "notes.projectPlaceholder": { en: "Project ID", es: "ID de proyecto", fr: "ID de projet", de: "Projekt-ID", th: "ID โปรเจกต์" },

  // ── Activity grid panel — top feeds ──────────────────────────
  "activity.grid.subagents": { en: "Subagents", es: "Subagentes", fr: "Sous-agents", de: "Subagenten", th: "ซับเอเจนต์", zh: "子代理", ja: "サブエージェント" },
  "activity.grid.completedTasks": { en: "Completed tasks", es: "Tareas completadas", fr: "Tâches terminées", de: "Erledigte Aufgaben", th: "งานที่เสร็จแล้ว", zh: "已完成任务", ja: "完了したタスク" },
  "activity.grid.seeAll": { en: "See all →", es: "Ver todo →", fr: "Tout voir →", de: "Alle anzeigen →", th: "ดูทั้งหมด →", zh: "查看全部 →", ja: "すべて表示 →" },
};

/**
 * Look up a translated string. Falls back: requested locale → English entry →
 * `fallback` (the English source string) → the key itself. Pass `params` to
 * interpolate `{name}` placeholders.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
): string {
  const row = STRINGS[key];
  const raw = row?.[currentLocale] ?? row?.en ?? fallback ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

// ── Global current locale ───────────────────────────────────────────────
// Kept in sync by `applySettings` so views can call `t(key)` without threading
// the locale through every props interface. Defaults to whatever
// `detectLocale()` returns; `applySettings` overrides it on first run.
//
// Persistence: the chosen locale lives in `UiSettings.locale` (localStorage,
// key `infinibot.control.settings.v1`). This survives reloads and view
// switches. TODO(multi-user): when the parallel profile system lands, namespace
// this per-user (store under the user record or a `userId`-keyed localStorage
// entry). Until then a single localStorage value is intentional and safe.
let currentLocale: AppLocale = detectLocale();

// Subscribers notified whenever the active locale changes. Lit views re-render
// automatically (they read `currentLocale` at render time and `applySettings`
// reassigns the reactive `settings` state), so they do NOT need this. It exists
// for imperative / non-Lit consumers that paint text once (e.g. code that does
// `el.textContent = ...`) and must repaint when the user switches language.
const localeChangeListeners = new Set<(locale: AppLocale) => void>();

export function getCurrentLocale(): AppLocale {
  return currentLocale;
}

export function setCurrentLocale(next: AppLocale): void {
  if (next === currentLocale) return;
  currentLocale = next;
  for (const cb of localeChangeListeners) {
    try {
      cb(next);
    } catch {
      /* a broken listener must not block the others */
    }
  }
}

/**
 * Subscribe to locale changes. Returns an unsubscribe function. Use only for
 * imperative consumers — Lit views re-render on their own.
 */
export function onLocaleChange(cb: (locale: AppLocale) => void): () => void {
  localeChangeListeners.add(cb);
  return () => localeChangeListeners.delete(cb);
}
