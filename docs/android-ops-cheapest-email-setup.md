# Android Ops Cheapest Business Email Setup

Date: 2026-08-22

## Goal

Create 12 usable business email addresses for account setup with the lowest monthly cost, while keeping verification emails easy for the dashboard to read.

## Best Setup

Use one domain you own with catch-all email routing.

Example addresses:

- `morpheous.ai01@yourdomain.com`
- `morpheous.ai02@yourdomain.com`
- `morpheous.ai03@yourdomain.com`
- through `morpheous.ai12@yourdomain.com`

These do not need to be 12 separate paid inboxes. Catch-all means every address at the domain can forward into one real inbox.

## Cheapest Recommended Option

### Option A: Cloudflare Email Routing

Best when you only need to receive verification emails.

Estimated cost:

- Domain: about $10-15/year depending on registrar and TLD
- Cloudflare Email Routing: free
- Destination inbox: use an inbox you already have

Why this is cheapest:

- Cloudflare Email Routing supports custom addresses and catch-all forwarding for free.
- You only maintain one destination inbox.
- The dashboard can generate 12 aliases automatically once the domain is entered.

Tradeoff:

- Cloudflare Email Routing is mainly for receiving/forwarding. If you need reliable outbound sending as each alias, use Option B.

### Option B: Purelymail

Best when you want cheap IMAP/SMTP access and catch-all on your own domain.

Estimated cost:

- Domain: about $10-15/year
- Purelymail: low-cost paid mail hosting, commonly around $10/year for normal small usage

Why this is better for automation:

- Supports IMAP/SMTP style mailbox access.
- Catch-all can route all aliases to one mailbox.
- Easier for a dashboard worker to poll for verification emails than a web-only free mail plan.

Tradeoff:

- Not free, but still far cheaper than 12 separate Google Workspace or Outlook business mailboxes.

## Avoid For This Workflow

### 12 separate Gmail accounts

Do not do this. It creates more verification, lockout, recovery, and device-trust problems.

### Zoho Free plan

Zoho has a free custom-domain plan in some regions, but its free plan does not include IMAP/POP/ActiveSync. That makes it weak for automated verification polling. It can work manually in a browser, but it is not the best automation path.

### 12 Google Workspace users

This is reliable but not cheap. It only makes sense later if each account needs a real staffed mailbox.

## Exact Setup Steps: Cloudflare Free Route

1. Buy or use a domain you control.

Example:

`yourdomain.com`

2. Add the domain to Cloudflare.

3. In Cloudflare, open Email Routing for the domain.

4. Add a destination inbox.

Example:

`yourmaininbox@gmail.com`

5. Verify the destination inbox from the email Cloudflare sends.

6. Enable Catch-all.

Set catch-all to forward all mail to your destination inbox.

7. Let Cloudflare add or show the required DNS records.

Required record types normally include MX and TXT/SPF-style records. Use Cloudflare's guided setup.

8. Test it.

Send an email to:

`anything-random@yourdomain.com`

Confirm it arrives in your destination inbox.

## Exact Setup Steps: Purelymail Route

1. Buy or use a domain you control.

2. Create a Purelymail account.

3. Add your domain inside Purelymail.

4. Add the DNS records Purelymail gives you.

Usually this includes MX, SPF/TXT, DKIM, and DMARC records.

5. Create one main mailbox.

Example:

`ops@yourdomain.com`

6. Enable catch-all routing for the domain.

Send all unmatched addresses to:

`ops@yourdomain.com`

7. Save the IMAP login/app password.

You will use this later in the dashboard so it can read verification emails.

## How To Input This Into Android Ops

Open:

`https://my-host-01.tail1234.ts.net:8449/android-ops`

Then:

1. Go to `Create Accounts`.

2. If slots do not exist, press `Create 12 Slots`.

3. Go to `Business Emails`.

4. Enter:

`Business Domain`

Example:

`yourdomain.com`

5. Choose provider:

- Use `IMAP / app password` for Purelymail or Gmail-forwarded inbox access.
- Use `Google Workspace API` only if you are using Google Workspace and OAuth/service auth later.
- Use `Cloudflare Email Routing` if you are only forwarding verification emails and reading them manually from the destination inbox.

6. Enter:

`Inbox Login`

Example:

`ops@yourdomain.com`

or the destination inbox receiving forwarded mail.

7. Enter:

`Inbox API Key / App Password`

Only enter this if the inbox supports app passwords or API access. Leave blank if you are doing manual verification at first.

8. Keep `Catch-all is enabled for this domain` checked.

9. Press `Create Business Aliases`.

The dashboard will attach aliases to the 12 account slots.

Expected result:

- `morpheous.ai01@yourdomain.com`
- `morpheous.ai02@yourdomain.com`
- through `morpheous.ai12@yourdomain.com`

## How Account Creation Should Run

1. Go to `Create Accounts`.

2. In `Create Account On Phone`, pick an account slot.

3. Pick the phone/device.

4. Press `Start On This Phone`.

The workflow should:

- Open the app on the selected phone.
- Fill allowed signup/login fields from the account slot.
- Watch the owned inbox for verification mail when inbox access is configured.
- Submit owned email verification codes or links.
- Pause for terms, CAPTCHA, 2FA, suspicious-login, or security prompts.
- Confirm login status.
- Sign out if the workflow requires it.

## Best Recommendation

Start with Cloudflare Email Routing if you want the cheapest possible setup today.

Move to Purelymail if you want the dashboard to automatically read verification emails through IMAP with less friction.

Do not create 12 separate email accounts unless there is a real business reason for separate inboxes.

