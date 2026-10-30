# Outreach Module — Production Setup Guide

## Overview

The outreach module handles cold email sending, tracking (open/click), and unsubscribe handling for the closed-loop lead pipeline.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OUTREACH_PROVIDER` | No | `mock` (default) or `resend` |
| `RESEND_API_KEY` | Yes (for Resend) | Resend API key from resend.com |
| `OUTREACH_FROM_EMAIL` | Yes (for Resend) | Verified sender email, e.g. `outreach@yourdomain.com` |
| `OUTREACH_FROM_NAME` | No | Display name, e.g. "Kev from Agency" |
| `OUTREACH_BASE_URL` | Yes (for tracking) | Public URL of your InfiniBot gateway, e.g. `https://gateway.yourdomain.com` |
| `UNSUBSCRIBE_SECRET` | Recommended | HMAC secret for unsubscribe tokens. Change from default! |
| `ANTHROPIC_API_KEY` | For qualifier | Used by qualifier LLM scoring |
| `HUNTER_API_KEY` | Optional | Hunter.io API key for email finding |
| `APOLLO_API_KEY` | Optional | Apollo.io API key for email finding |
| `IMAP_HOST` | Optional | IMAP server for inbox listener |
| `IMAP_USER` | Optional | IMAP username |
| `IMAP_PASS` | Optional | IMAP password |

## Sender Identity

Create `~/.infinibot/sender-identity.json`:

```json
{
  "firstName": "Kev",
  "lastName": "Smith",
  "email": "outreach@yourdomain.com",
  "companyName": "Your Agency Name",
  "physicalAddress": "123 Main St, Miami, FL 33101",
  "replyTo": "outreach@yourdomain.com"
}
```

This is **required for CAN-SPAM compliance**. Every outbound email must include a physical address and unsubscribe link.

## DNS Setup (Resend)

Before sending from your domain with Resend:

1. **Add domain** in the Resend dashboard at resend.com/domains
2. **Set DNS records** (Resend provides these):
   - SPF: `v=spf1 include:amazonses.com ~all`
   - DKIM: Add the CNAME records provided by Resend
   - DMARC: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
3. **Verify domain** in Resend dashboard
4. **Warm up the domain** — DO NOT send 1000 emails day 1. Start with 50/day and ramp over 2 weeks.

## Email Warm-up

Cold sends from a fresh domain land in spam without warm-up. Options:
- **Manual**: Send 50/day week 1, 100/day week 2, 250/day week 3, etc.
- **Automated**: Use a service like Mailwarm, Warmbox, or Lemwarm.
- **Wait**: Domain needs 2-4 weeks of sending history before deliverability improves.

## Template Setup

Create `~/.infinibot/outreach/templates/`:

```bash
mkdir -p ~/.infinibot/outreach/templates
```

Each `.md` file is a template with YAML frontmatter:

```markdown
---
subject: Quick question about {{lead.name}}
cadence_days: [3, 7, 14]
max_followups: 3
---
Hi there,

I noticed {{lead.website || "your business"}} and was impressed by {{lead.recommended_pitch}}.

[Your pitch here]

Best,
{{me.first_name}}
{{me.company}}

---
{{physical_address}}
[Unsubscribe]({{unsubscribe_url}})
```

Available variables:
- `{{lead.name}}` — Business name
- `{{lead.website}}` — Website URL
- `{{lead.recommended_pitch}}` — AI-generated pitch from qualifier
- `{{me.first_name}}`, `{{me.last_name}}`, `{{me.company}}`, `{{me.email}}`
- `{{unsubscribe_url}}` — One-click unsubscribe link (required)
- `{{physical_address}}` — Your physical address (required for CAN-SPAM)

## A/B Template Variants

To A/B test, create a variant file:

```markdown
---
subject: One quick thing about {{lead.name}} [B]
cadence_days: [2, 5, 10]
max_followups: 2
variant_of: default
---
...
```

The send worker round-robins between the base and all its variants.

## Tracking Setup

The gateway must serve:
- `GET /api/track/open/:msg_id` — tracking pixel endpoint
- `GET /api/track/click/:msg_id?url=…` — click redirect
- `GET /api/unsubscribe/:lead_id?token=…` — unsubscribe handler

TODO(closed-loop): wire `handleTrackingRequest` from `tracking-http.ts` into the gateway HTTP server at startup.

## Compliance Checklist

- [ ] Physical address in every email (`sender-identity.json`)
- [ ] One-click unsubscribe link in every email template (`{{unsubscribe_url}}`)
- [ ] Unsubscribed check before every send (implemented in `send.ts`)
- [ ] B2B targeting only (not consumer email lists)
- [ ] Identifiable sender (from name + email must match your identity)
- [ ] No deceptive subject lines
- [ ] Honor opt-outs within 10 business days (automated via `lifecycleStatus: unsubscribed`)

## Rate Limits

| Provider | Free | Paid |
|---|---|---|
| Resend | 3,000/month | Up to 50,000/month (Starter) |
| SendGrid | 100/day | 40,000/month (Essentials) |

Start on the free tier during warm-up. Don't exceed 50 sends/day in week 1.
