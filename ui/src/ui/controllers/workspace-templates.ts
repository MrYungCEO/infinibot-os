/**
 * Workspace Templates — pre-built mini-projects that scaffold a working
 * site / form / page into a workspace directory.
 *
 * Each template defines:
 *   - `category` — broad bucket the gallery groups by
 *   - `files`    — a list of relative paths + content to write
 *   - `binding`  — optional CRM/database hookup spec; when present the
 *                  workspace controller registers a FormBinding and rewrites
 *                  the placeholder action URL `__FORM_ACTION__` in every
 *                  template file with the live `/api/forms/<id>/submit` URL
 *
 * Form bindings always operate against an existing or newly-created
 * database in the InfiniBot databases system, so a Business Inquiry Form
 * can drop straight into the Clients / Leads / Companies CRM tables (or
 * any custom database the user spins up).
 */

export interface BindingFieldMap {
  /** Form input `name` attribute → property name on the target database. */
  formField: string;
  propertyName: string;
}

export interface TemplateBindingSpec {
  /** Friendly name the user sees in the bind modal. */
  label: string;
  /**
   * Default target system role (resolves to the user's chosen DB for that
   * role) — lets a "Business Inquiry" template auto-suggest the Leads
   * database. User can override at apply-time.
   */
  defaultRole?: "projects" | "tasks" | "notes" | "clients" | "leads";
  /**
   * Suggested database name when the user picks "Create new database…"
   * during apply. The new DB ships with the properties listed below.
   */
  newDatabaseName?: string;
  /** Properties to seed when creating a new database for this template. */
  newDatabaseProperties?: Array<{
    name: string;
    type: import("../../../src/databases/types.js").PropertyType;
  }>;
  fields: BindingFieldMap[];
  titleTemplate?: string;
}

export interface TemplateFile {
  path: string;
  content: string;
}

export type TemplateCategory =
  | "form"
  | "landing"
  | "site"
  | "utility";

export interface WorkspaceTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  /** Tagline shown on the gallery card. */
  tagline: string;
  /** Emoji glyph for the gallery card (no emoji elsewhere in the UI). */
  glyph: string;
  files: TemplateFile[];
  binding?: TemplateBindingSpec;
}

// ── Shared scaffold pieces ───────────────────────────────────────────

const HUD_CSS = `:root {
  --bg-0: #050514;
  --bg-1: #0c0c1f;
  --fg: #e4e4e7;
  --muted: rgba(228, 228, 231, 0.65);
  --primary: #d4af37;
  --primary-soft: rgba(212, 175, 55, 0.18);
  --accent: #8b5cf6;
  --border: rgba(212, 175, 55, 0.2);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(139, 92, 246, 0.18), transparent 60%),
    linear-gradient(180deg, var(--bg-1), var(--bg-0));
  color: var(--fg);
  min-height: 100vh;
  line-height: 1.55;
}
.container { max-width: 1100px; margin: 0 auto; padding: 60px 24px; }
.card {
  background: linear-gradient(135deg, rgba(15,15,20,0.85) 0%, rgba(8,8,12,0.92) 100%);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 32px;
  backdrop-filter: blur(22px) saturate(180%);
  box-shadow: 0 16px 48px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06);
}
h1, h2, h3 { letter-spacing: -0.02em; }
h1 { font-size: clamp(32px, 5vw, 56px); margin: 0 0 20px; }
h2 { font-size: clamp(22px, 3vw, 32px); margin: 0 0 16px; color: var(--primary); }
p { color: var(--muted); }
.btn {
  display: inline-block;
  padding: 12px 24px;
  border-radius: 10px;
  border: 1px solid var(--primary);
  background: linear-gradient(135deg, var(--primary-soft), transparent);
  color: var(--primary);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  cursor: pointer;
  font-size: 12px;
}
.btn:hover { background: var(--primary); color: var(--bg-0); }
form label { display: block; margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
form input, form textarea, form select {
  width: 100%; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(0,0,0,0.5);
  color: var(--fg);
  font-family: inherit; font-size: 14px;
}
form input:focus, form textarea:focus, form select:focus {
  outline: none; border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(212,175,55,0.25);
}
.success { padding: 18px; border-radius: 10px; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.4); color: #6ee7b7; margin-top: 20px; display: none; }
.success.show { display: block; }
.error { padding: 18px; border-radius: 10px; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.4); color: #fca5a5; margin-top: 20px; display: none; }
.error.show { display: block; }
`;

const FORM_SUBMIT_JS = `
(function () {
  const form = document.querySelector('form[data-infinibot-form]');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const success = form.parentElement.querySelector('.success');
    const error = form.parentElement.querySelector('.error');
    if (success) success.classList.remove('show');
    if (error) error.classList.remove('show');
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = v; });
    const action = form.getAttribute('action') || '__FORM_ACTION__';
    const submitBtn = form.querySelector('button[type=submit]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'submit failed');
      form.reset();
      if (json.redirect) {
        window.location.href = json.redirect;
        return;
      }
      if (success) success.classList.add('show');
    } catch (err) {
      if (error) {
        error.textContent = 'Something went wrong: ' + err.message;
        error.classList.add('show');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
})();
`;

// ── Templates ──────────────────────────────────────────────────────

const businessInquiry: WorkspaceTemplate = {
  id: "business-inquiry-form",
  name: "Business Inquiry Form",
  category: "form",
  glyph: "📥",
  tagline: "Capture inbound leads — name, email, company, message",
  description:
    "A standalone single-page inquiry form that posts to your CRM. Bind it " +
    "to the Leads database (or any database with Name/Email/Company/Message " +
    "properties) and every submission becomes a row.",
  binding: {
    label: "Inquiry submissions",
    defaultRole: "leads",
    newDatabaseName: "Inquiry Leads",
    newDatabaseProperties: [
      { name: "Name", type: "title" },
      { name: "Email", type: "email" },
      { name: "Company", type: "richText" },
      { name: "Message", type: "richText" },
      { name: "Source", type: "select" },
    ],
    fields: [
      { formField: "name", propertyName: "Name" },
      { formField: "email", propertyName: "Email" },
      { formField: "company", propertyName: "Company" },
      { formField: "message", propertyName: "Message" },
    ],
    titleTemplate: "{{name}} — {{company}}",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Get in touch</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="container">
    <div class="card">
      <h1>Tell us about your project</h1>
      <p>Drop your details and we'll be in touch within one business day.</p>
      <form data-infinibot-form action="__FORM_ACTION__">
        <label for="name">Your name</label>
        <input id="name" name="name" type="text" required />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />
        <label for="company">Company</label>
        <input id="company" name="company" type="text" />
        <label for="message">What are you looking to build?</label>
        <textarea id="message" name="message" rows="5"></textarea>
        <!-- Honeypot — hidden from real users, bots fill it. -->
        <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
        <div style="margin-top:24px">
          <button type="submit" class="btn">Send inquiry</button>
        </div>
        <div class="success">Thanks — we'll be in touch soon.</div>
        <div class="error"></div>
      </form>
    </div>
  </main>
  <script src="form.js"></script>
</body>
</html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const contactForm: WorkspaceTemplate = {
  id: "contact-form",
  name: "Contact Form",
  category: "form",
  glyph: "✉️",
  tagline: "Minimal contact form — name, email, message",
  description:
    "Lean drop-in contact form. Same submission pattern as the inquiry " +
    "template but smaller. Good fit for portfolio sites or simple landings.",
  binding: {
    label: "Contact submissions",
    newDatabaseName: "Contact Submissions",
    newDatabaseProperties: [
      { name: "Name", type: "title" },
      { name: "Email", type: "email" },
      { name: "Message", type: "richText" },
    ],
    fields: [
      { formField: "name", propertyName: "Name" },
      { formField: "email", propertyName: "Email" },
      { formField: "message", propertyName: "Message" },
    ],
    titleTemplate: "{{name}}",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Contact</title><link rel="stylesheet" href="style.css" /></head>
<body><main class="container"><div class="card">
<h1>Say hello</h1>
<p>Send a note and I'll get back to you.</p>
<form data-infinibot-form action="__FORM_ACTION__">
  <label for="name">Name</label><input id="name" name="name" type="text" required />
  <label for="email">Email</label><input id="email" name="email" type="email" required />
  <label for="message">Message</label><textarea id="message" name="message" rows="5" required></textarea>
  <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
  <div style="margin-top:24px"><button type="submit" class="btn">Send</button></div>
  <div class="success">Got it — thanks!</div><div class="error"></div>
</form></div></main><script src="form.js"></script></body></html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const landingPage: WorkspaceTemplate = {
  id: "landing-hero-cta",
  name: "Landing Page",
  category: "landing",
  glyph: "🚀",
  tagline: "Hero + features + lead-capture form",
  description:
    "Single-page landing with a hero headline, three-column feature grid, " +
    "and a footer signup form bound to your CRM. Edit the copy in index.html " +
    "and the headline is yours; bindings handle the rest.",
  binding: {
    label: "Landing signups",
    defaultRole: "leads",
    newDatabaseName: "Landing Signups",
    newDatabaseProperties: [
      { name: "Name", type: "title" },
      { name: "Email", type: "email" },
      { name: "Plan Interest", type: "select" },
    ],
    fields: [
      { formField: "name", propertyName: "Name" },
      { formField: "email", propertyName: "Email" },
      { formField: "plan", propertyName: "Plan Interest" },
    ],
    titleTemplate: "{{name}} — {{email}}",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Build the future, today</title><link rel="stylesheet" href="style.css" /></head>
<body>
<main class="container">
  <section style="text-align:center;padding:80px 0">
    <h1>Build the future, today</h1>
    <p style="font-size:18px;max-width:640px;margin:0 auto 32px">
      A drop-in platform that does what your old stack only promised. Reserve your
      spot and we'll set you up in days, not months.
    </p>
    <a href="#signup" class="btn">Get early access</a>
  </section>

  <section style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:60px 0">
    <div class="card"><h2>Faster</h2><p>10× less time from idea to live than your current setup.</p></div>
    <div class="card"><h2>Smarter</h2><p>Built-in CRM and ops automations that scale with you.</p></div>
    <div class="card"><h2>Yours</h2><p>Local-first, fully self-hostable. No platform tax.</p></div>
  </section>

  <section id="signup" class="card" style="max-width:560px;margin:60px auto">
    <h2>Reserve early access</h2>
    <form data-infinibot-form action="__FORM_ACTION__">
      <label for="name">Name</label><input id="name" name="name" type="text" required />
      <label for="email">Email</label><input id="email" name="email" type="email" required />
      <label for="plan">Plan you're eyeing</label>
      <select id="plan" name="plan">
        <option value="Starter">Starter</option>
        <option value="Growth">Growth</option>
        <option value="Enterprise">Enterprise</option>
      </select>
      <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
      <div style="margin-top:24px"><button type="submit" class="btn">Reserve my spot</button></div>
      <div class="success">You're on the list — we'll be in touch.</div>
      <div class="error"></div>
    </form>
  </section>
</main>
<script src="form.js"></script>
</body></html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const comingSoon: WorkspaceTemplate = {
  id: "coming-soon",
  name: "Coming Soon",
  category: "site",
  glyph: "⏳",
  tagline: "Email capture + countdown",
  description:
    "Pre-launch placeholder with a countdown and email capture so you bank " +
    "interested visitors while you build. Bind to a Newsletter or Waitlist DB.",
  binding: {
    label: "Waitlist signups",
    newDatabaseName: "Waitlist",
    newDatabaseProperties: [
      { name: "Email", type: "title" },
      { name: "Joined", type: "date" },
    ],
    fields: [{ formField: "email", propertyName: "Email" }],
    titleTemplate: "{{email}}",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Coming soon</title><link rel="stylesheet" href="style.css" /></head>
<body><main class="container" style="text-align:center;padding-top:140px">
<h1 style="font-size:clamp(48px,8vw,96px)">Coming soon.</h1>
<p style="font-size:18px;max-width:520px;margin:0 auto 40px">
  We're putting the final touches on something good. Drop your email and you'll
  be the first to know when it ships.
</p>
<form data-infinibot-form action="__FORM_ACTION__" style="max-width:420px;margin:0 auto;display:flex;gap:8px">
  <input id="email" name="email" type="email" placeholder="you@you.com" required style="flex:1" />
  <button type="submit" class="btn">Notify me</button>
  <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
</form>
<div class="success" style="margin:20px auto;max-width:420px">You're on the list.</div>
<div class="error" style="margin:20px auto;max-width:420px"></div>
</main><script src="form.js"></script></body></html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const pricingPage: WorkspaceTemplate = {
  id: "pricing-page",
  name: "Pricing Page",
  category: "landing",
  glyph: "💼",
  tagline: "3-tier pricing + book-a-call form",
  description:
    "Three pricing cards (Starter / Growth / Enterprise) and a 'talk to sales' " +
    "form. Calls drop into Deals or Leads; great for B2B services.",
  binding: {
    label: "Sales conversations",
    defaultRole: "leads",
    newDatabaseName: "Sales Conversations",
    newDatabaseProperties: [
      { name: "Name", type: "title" },
      { name: "Email", type: "email" },
      { name: "Company", type: "richText" },
      { name: "Tier", type: "select" },
      { name: "Notes", type: "richText" },
    ],
    fields: [
      { formField: "name", propertyName: "Name" },
      { formField: "email", propertyName: "Email" },
      { formField: "company", propertyName: "Company" },
      { formField: "tier", propertyName: "Tier" },
      { formField: "notes", propertyName: "Notes" },
    ],
    titleTemplate: "{{name}} — {{company}} ({{tier}})",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pricing</title><link rel="stylesheet" href="style.css" /></head>
<body><main class="container">
<section style="text-align:center;padding:60px 0">
  <h1>Pricing that scales with you</h1>
  <p style="max-width:540px;margin:0 auto">Same features. Different volume bands.</p>
</section>
<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">
  <div class="card"><h2>Starter</h2><p style="font-size:32px;color:var(--fg)">$49<span style="font-size:14px;color:var(--muted)">/mo</span></p>
    <ul style="padding-left:20px;color:var(--muted);font-size:14px;margin:20px 0"><li>Up to 5 seats</li><li>10K monthly events</li><li>Email support</li></ul>
    <a href="#talk" class="btn">Pick Starter</a></div>
  <div class="card" style="border-color:var(--primary);box-shadow:0 0 40px rgba(212,175,55,0.2)"><h2>Growth</h2><p style="font-size:32px;color:var(--fg)">$199<span style="font-size:14px;color:var(--muted)">/mo</span></p>
    <ul style="padding-left:20px;color:var(--muted);font-size:14px;margin:20px 0"><li>Up to 30 seats</li><li>100K monthly events</li><li>Priority support</li><li>API access</li></ul>
    <a href="#talk" class="btn">Pick Growth</a></div>
  <div class="card"><h2>Enterprise</h2><p style="font-size:32px;color:var(--fg)">Custom</p>
    <ul style="padding-left:20px;color:var(--muted);font-size:14px;margin:20px 0"><li>Unlimited seats</li><li>Unlimited events</li><li>SLAs &amp; dedicated rep</li><li>SSO + audit logs</li></ul>
    <a href="#talk" class="btn">Talk to sales</a></div>
</section>

<section id="talk" class="card" style="max-width:640px;margin:60px auto">
  <h2>Talk to sales</h2>
  <form data-infinibot-form action="__FORM_ACTION__">
    <label for="name">Name</label><input id="name" name="name" type="text" required />
    <label for="email">Email</label><input id="email" name="email" type="email" required />
    <label for="company">Company</label><input id="company" name="company" type="text" />
    <label for="tier">Interested in</label>
    <select id="tier" name="tier"><option>Starter</option><option>Growth</option><option>Enterprise</option></select>
    <label for="notes">What are you trying to solve?</label>
    <textarea id="notes" name="notes" rows="4"></textarea>
    <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
    <div style="margin-top:24px"><button type="submit" class="btn">Book the call</button></div>
    <div class="success">Booked — we'll reach out today.</div><div class="error"></div>
  </form>
</section>
</main><script src="form.js"></script></body></html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const newsletter: WorkspaceTemplate = {
  id: "newsletter-signup",
  name: "Newsletter Signup",
  category: "form",
  glyph: "📰",
  tagline: "Single-field email capture, embeddable",
  description:
    "Tiny one-input newsletter form you can drop into any other site as " +
    "an iframe. Posts straight to a Subscribers database.",
  binding: {
    label: "Newsletter subscribers",
    newDatabaseName: "Newsletter Subscribers",
    newDatabaseProperties: [
      { name: "Email", type: "title" },
      { name: "Subscribed", type: "date" },
      { name: "Tags", type: "multiSelect" },
    ],
    fields: [{ formField: "email", propertyName: "Email" }],
    titleTemplate: "{{email}}",
  },
  files: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Subscribe</title><link rel="stylesheet" href="style.css" /></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh">
<div class="card" style="width:min(420px,92vw)">
  <h2 style="font-size:18px">Stay in the loop</h2>
  <p style="font-size:13px">One short email per week. Unsubscribe anytime.</p>
  <form data-infinibot-form action="__FORM_ACTION__" style="display:flex;gap:6px">
    <input id="email" name="email" type="email" placeholder="you@you.com" required style="flex:1" />
    <button type="submit" class="btn">Join</button>
    <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
  </form>
  <div class="success" style="margin-top:14px;font-size:12px">You're in.</div>
  <div class="error" style="margin-top:14px;font-size:12px"></div>
</div>
<script src="form.js"></script></body></html>`,
    },
    { path: "style.css", content: HUD_CSS },
    { path: "form.js", content: FORM_SUBMIT_JS },
  ],
};

const codeStarter: WorkspaceTemplate = {
  id: "code-starter",
  name: "Empty Code Project",
  category: "utility",
  glyph: "🧩",
  tagline: "README + .gitignore — let Claude Coder fill in the rest",
  description:
    "No-frills starter for when you want Claude Coder to drive — drops in " +
    "a README that describes the project and a sensible .gitignore. No CRM " +
    "binding (this isn't a form template).",
  files: [
    {
      path: "README.md",
      content: `# {{workspace}}

Started from the InfiniBot workspace template gallery.

## What this is

(Describe the project here, then ask Claude Coder to scaffold the rest.)

## Run

\`\`\`bash
# add your run command
\`\`\`
`,
    },
    {
      path: ".gitignore",
      content: `node_modules/
dist/
.env
.env.local
*.log
.DS_Store
.idea/
.vscode/
`,
    },
  ],
};

// ── Snippet library — ready-to-paste components ────────────────────

export interface ComponentSnippet {
  id: string;
  name: string;
  description: string;
  /** Where it best fits — informs the gallery ordering. */
  surface: "html" | "css" | "js";
  /** Hint shown in the picker about which file to paste into. */
  intoFile?: string;
  /**
   * Source. May contain `__FORM_ACTION__` placeholder which the controller
   * substitutes with a live binding URL when inserted via the bind flow.
   */
  source: string;
  /** When set, inserting this snippet prompts for a CRM binding. */
  binding?: TemplateBindingSpec;
}

export const COMPONENT_LIBRARY: ComponentSnippet[] = [
  {
    id: "snippet-inquiry-form",
    name: "Inquiry form (CRM-bound)",
    description:
      "Drop-in HTML inquiry form that posts to a chosen CRM database via a " +
      "form binding. Use inside an existing landing page.",
    surface: "html",
    intoFile: "index.html",
    binding: businessInquiry.binding,
    source: `<form data-infinibot-form action="__FORM_ACTION__">
  <label for="name">Name</label>
  <input id="name" name="name" type="text" required />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />
  <label for="company">Company</label>
  <input id="company" name="company" type="text" />
  <label for="message">Message</label>
  <textarea id="message" name="message" rows="4"></textarea>
  <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
  <button type="submit" class="btn">Send</button>
  <div class="success">Thanks — we'll be in touch.</div>
  <div class="error"></div>
</form>`,
  },
  {
    id: "snippet-newsletter",
    name: "Newsletter input (CRM-bound)",
    description:
      "Inline email-only signup. Bind to a Subscribers database; auto-rewrites " +
      "the action URL on insert.",
    surface: "html",
    intoFile: "index.html",
    binding: newsletter.binding,
    source: `<form data-infinibot-form action="__FORM_ACTION__" style="display:flex;gap:6px">
  <input id="email" name="email" type="email" placeholder="you@you.com" required />
  <button type="submit" class="btn">Subscribe</button>
  <input type="text" name="company_url" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" />
</form>`,
  },
  {
    id: "snippet-pricing-cards",
    name: "Pricing — 3 tier cards",
    description: "Three responsive pricing cards using the HUD design tokens. No binding.",
    surface: "html",
    intoFile: "index.html",
    source: `<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">
  <div class="card"><h2>Starter</h2><p style="font-size:32px">$49/mo</p><a href="#" class="btn">Pick</a></div>
  <div class="card" style="border-color:var(--primary)"><h2>Growth</h2><p style="font-size:32px">$199/mo</p><a href="#" class="btn">Pick</a></div>
  <div class="card"><h2>Enterprise</h2><p style="font-size:32px">Custom</p><a href="#" class="btn">Talk</a></div>
</section>`,
  },
  {
    id: "snippet-form-submit-js",
    name: "Form submit handler (JS)",
    description:
      "The progressive-enhancement JS that wires `<form data-infinibot-form>` " +
      "to a fetch POST and shows success / error messages.",
    surface: "js",
    intoFile: "form.js",
    source: FORM_SUBMIT_JS,
  },
  {
    id: "snippet-hud-css",
    name: "HUD glassmorphism stylesheet",
    description:
      "Drop-in CSS that matches the InfiniBot HUD theme — gradient bg, glass " +
      "cards, primary-tinted form inputs.",
    surface: "css",
    intoFile: "style.css",
    source: HUD_CSS,
  },
];

// ── Registry ───────────────────────────────────────────────────────

export const TEMPLATE_LIBRARY: WorkspaceTemplate[] = [
  businessInquiry,
  contactForm,
  landingPage,
  pricingPage,
  newsletter,
  comingSoon,
  codeStarter,
];

export function findTemplate(id: string): WorkspaceTemplate | null {
  return TEMPLATE_LIBRARY.find((t) => t.id === id) ?? null;
}

export function findSnippet(id: string): ComponentSnippet | null {
  return COMPONENT_LIBRARY.find((s) => s.id === id) ?? null;
}
