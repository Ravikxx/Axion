# Privacy Policy

**Last updated: June 6, 2026**

## Overview

Axion is an open-source AI coding agent. This privacy policy explains how Axion handles data when you use OAuth integrations (GitHub, Google).

## What data Axion accesses

When you connect Google via `/oauth connect google`, Axion may access:

- **Google Drive** — to list, read, and search your files when you ask it to
- **Google Calendar** — to read and create calendar events when you ask it to
- **Gmail** — to read and send emails when you ask it to

When you connect GitHub via `/oauth connect github`, Axion may access:

- Your repositories, issues, and pull requests when you ask it to

## How data is used

- All data accessed through OAuth is used **only to respond to your requests** within the Axion chat interface
- Axion does **not** store, log, or transmit your Google or GitHub data to any third party
- OAuth tokens are stored **locally on your machine** in `~/.axion/oauth.json` and never sent anywhere except the respective service's API

## Data storage

- OAuth tokens are stored locally on your device only
- No data is sent to Axion Labs servers
- Axion is a local application — all processing happens on your machine or through the AI provider you configure (Anthropic, OpenAI, etc.)

## Third-party services

Axion connects to AI providers (Anthropic, OpenAI, Google Gemini, etc.) using API keys you supply. Please refer to each provider's privacy policy for how they handle your data.

## Your control

- You can disconnect any service at any time with `/oauth revoke <service>`
- You can delete your local token file at `~/.axion/oauth.json`
- Axion is open source — you can audit exactly what it does at [github.com/Ravikxx/axion](https://github.com/Ravikxx/axion)

## Contact

For questions, open an issue at [github.com/Ravikxx/axion/issues](https://github.com/Ravikxx/axion/issues) or visit [axion.amplifiedsmp.org](https://axion.amplifiedsmp.org).
