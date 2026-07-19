# Privacy Policy

**Last updated: July 19, 2026**

## Overview

Axion is an open-source AI coding agent with local software and hosted services. Most CLI work happens on your machine, while model inference, accounts, web chat, usage tracking, billing, email, vision, and connected integrations may send data to remote services. This policy explains what stays local, what Axion Labs stores, and which providers process data.

Axion Labs operates a hosted API, authentication, usage, billing, email-preference, and chat backend on Cloudflare. Lumen and the default vision model run on Hugging Face infrastructure. Axion does not use your conversations for model training unless you explicitly opt in with `/contribute`.

## Local-only features

These stay on your device unless their output is included in a prompt or sent through a hosted feature.

- **Reading, editing, and running code** — the core agent operates on your local filesystem. File contents leave your device only when included as context for the AI model you selected.
- **Integration tokens** — stored in `~/.axion/oauth.json` and sent to the corresponding service API, not to Axion Labs. Connected data may become prompt context and then be sent to your selected model provider.
  - **GitHub** — repositories, issues, and pull requests available to the granted scopes.
  - **Google** — Google Drive and Google Calendar data available to the granted scopes. Axion does not request Gmail access.
  - **Notion** — pages and databases shared with the integration.
  - **Slack** — channels and messages available to the bot token.
- **Voice recording** — recorded to a temporary `.wav` file locally before any hosted transcription.
- **Session memory** — local CLI memory, preferences, and notes are stored under `~/.axion/`.
- **Third-party provider keys** — keys you configure are stored locally and sent to the provider they belong to.
- **Local models** — Ollama inference runs on your machine.
- **Extension-to-CLI bridge** — the Chrome extension talks to the local CLI over `127.0.0.1`. That local bridge itself does not contact Axion Labs.

## Axion Labs hosted account and service data

Axion's Cloudflare-hosted backend stores and processes data needed to run accounts and hosted features, including:

- account identifiers, email address, password hash or linked OAuth identifier, verification and reset state, registration IP address, suspension state, and appeal records;
- Axion-issued API keys and their status, request counts, token counts, calculated usage cost, allowance windows, and rate-limit records;
- plan and subscription status, credit balances, credit-code redemptions, and Square customer or subscription identifiers;
- signed-in web chat history and chat metadata used to sync conversations across sessions;
- email and announcement preferences, organization membership and invitations, and CLI device-login codes;
- administrative test changes to plan, allowance usage, or credit balances, including who made the change and when.

Axion does not store your full payment-card number. Square processes payment details. Announcement subscriptions can exist separately from an Axion account, so deleting an account does not by itself unsubscribe a separately registered announcement email.

## Hosted features

### AI model inference

Your prompt and any file contents, command output, page text, or other context included with it are transmitted to the selected model provider.

- **Third-party providers** such as Anthropic, OpenAI, Google Gemini, Groq, Mistral, OpenRouter, and OpenCode receive requests directly when you configure and select them.
- **Lumen** routes through Axion Labs' Cloudflare backend at `api.amplifiedsmp.org` and then to Lumen inference on Hugging Face. Keyless access is limited to 50 requests per day per IP address. Signed-in usage is tracked account-wide as token-based cost against the Free or Pro allowance and any redeemed credits; per-key request and token totals are also recorded.
- **IP addresses** are collected during registration and used for duplicate-account and abuse detection. Registration IPs are kept with the account; operational rate-limit records expire according to their configured windows.

### Voice transcription and text-to-speech

- **Transcription** uploads locally recorded audio to OpenAI (`whisper-1`) when an OpenAI key is configured, or Groq (`whisper-large-v3-turbo`) otherwise. Transcription is unavailable without a supported provider key.
- **Text-to-speech** sends the text to OpenAI's TTS API. Temporary local audio is deleted after playback.

### Screen vision

Screen-vision and computer-use features capture a screenshot and send it to a vision model. The default is Axion Labs' `axion-vision` model hosted on Hugging Face. If you configure another vision provider, the screenshot goes to that provider instead.

### Browser control

The Chrome extension requests broad browser permissions so it can read pages, click elements, fill forms, and capture the visible tab when you direct it. In standalone extension chat, page data sent for model reasoning goes to the provider configured in the extension. When the authenticated local bridge is enabled, Axion Desktop can request page reads and actions over a loopback WebSocket; returned page data may then become prompt context sent by Desktop to its configured model provider. If Lumen is selected in either flow, the request follows the Cloudflare-to-Hugging-Face path described above. Provider keys and the bridge pairing token are stored in extension-owned Chrome storage.

### Email and payments

- **Resend** processes account verification, password-reset, invitation, and announcement emails.
- **Square** processes Pro checkout and payment information. Axion receives and stores the customer or subscription identifiers and status needed to manage access.

### Training-data contributions (`/contribute`)

Contributing is opt-in. Nothing is submitted merely because a contribution prompt appears.

- The session is redacted first: file contents are stripped and message or tool text is truncated, leaving limited structure, text excerpts, and metadata.
- The redacted session is uploaded to Axion Labs' collection endpoint on Cloudflare Workers.
- If the upload fails, the session is stored locally under `~/.axion/donations/` and is not uploaded automatically later.
- Use `/contribute optout` to disable contribution prompts or `/contribute skip` to dismiss the current prompt.

## Third-party privacy policies

- Hugging Face (Lumen and vision inference): https://huggingface.co/privacy
- Cloudflare (hosted backend and contribution endpoint): https://www.cloudflare.com/policies/privacy/
- Square (payments and subscriptions): https://squareup.com/us/en/legal/general/privacy
- Resend (transactional and announcement email): https://resend.com/legal/privacy-policy
- Your configured AI providers and connected integrations: see each provider's privacy policy.

## Your control

- Delete individual signed-in web chats from the chat interface, or delete your account and linked account data from Settings.
- Use the unsubscribe link in an announcement email to remove a separate announcement subscription.
- Disconnect an OAuth service with `/oauth revoke <service>`, or delete `~/.axion/oauth.json`.
- Use your own provider keys or a local model through Ollama to keep inference off Axion Labs' model endpoint.
- Opt out of contribution prompts with `/contribute optout`, and delete local files under `~/.axion/donations/` yourself.
- Axion is open source — review the code at [github.com/AxionLabsAI/axion](https://github.com/AxionLabsAI/axion).

## Contact

For questions, open an issue at [github.com/AxionLabsAI/axion/issues](https://github.com/AxionLabsAI/axion/issues) or visit [axion.amplifiedsmp.org](https://axion.amplifiedsmp.org).
