# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Price Games, please report it **privately**. Do not open a public GitHub issue, and do not disclose the issue publicly until we've had a chance to address it.

**Email:** `security@price.games`

Please include:

- A description of the issue
- Steps to reproduce, or a proof-of-concept
- Affected versions or commits
- Your assessment of impact (data exposure, account takeover, denial of service, etc.)
- Whether you'd like to be credited in the fix announcement

## What to expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** within 7 business days.
- **Resolution target** within 90 days for confirmed issues, sooner for high-severity ones.
- A **fix announcement** once the issue is resolved and a patched release is available. We'll credit reporters who want credit.

## Scope

In scope:

- The main game server (`apps/server/`)
- The web client (`apps/web/`)
- The Chrome extension (`apps/extension/`)
- The streamer bot (`packages/bot-streamer/`)
- Shared code (`packages/shared/`)
- Deployment configuration (Caddyfile, Dockerfiles, CI)

Out of scope:

- Vulnerabilities in third-party services we depend on (report those to the vendor)
- Issues that require already-compromised infrastructure or social-engineered admin credentials
- Self-XSS or other attacks requiring the victim to paste attacker-supplied code into a privileged context
- Findings against `.env` files or other gitignored secrets that exist only on disk (operational concern, not a code vulnerability)

## Supported versions

Only the `main` branch is actively supported. Production runs from the most recent green build on `main`.

## Safe-harbor

We will not pursue legal action against good-faith security researchers who:

- Make a reasonable effort to avoid privacy violations and service disruption
- Do not exfiltrate, modify, or destroy data beyond what is necessary to demonstrate the issue
- Give us a reasonable time to fix the issue before public disclosure
- Do not exploit the issue beyond what is needed for proof-of-concept

Thank you for helping keep Price Games and its players safe.
