# Security Policy

## Supported versions

This is currently a single active branch project. Security fixes are applied to the latest code.

## Reporting a vulnerability

Please do **not** open public issues for security problems.

Contact the maintainer directly and include:

- impact summary
- reproduction steps
- affected version/commit
- suggested mitigation (if available)

## Operational security notes

- Never commit `.env`, `.state/`, logs with sensitive data, or session files.
- The WhatsApp auth/session folder contains sensitive credentials.
- Restrict `ALLOWED_WHATSAPP_NUMBER` to your own number.
- Review prompts before enabling any broad automation on your host.
