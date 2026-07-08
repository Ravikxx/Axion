# Privacy Policy

**Last updated: July 7, 2026**

## Overview

Axion is an open-source AI coding agent that runs on your machine. Most of what
Axion does happens locally, but some features send data to remote services — the
AI providers you configure, the integrations you connect, and Axion Labs' own
hosted backend (for Lumen and usage tracking). This policy explains exactly what
stays local and what leaves your device.

**Axion Labs does not operate its own data-collecting servers.** We run two hosted
pieces of infrastructure: Lumen model inference on [Hugging Face](https://huggingface.co/privacy),
and an API/auth/usage-tracking backend on [Cloudflare Workers](https://www.cloudflare.com/privacypolicy/).
Neither logs your prompts as a product feature. Everything else routes either to
providers you choose or nowhere at all.

## Local-only features

These never leave your device.

- **Reading, editing, and running code** — the core agent loop operates on your local filesystem. File contents are only sent onward as part of a prompt to the AI model you've selected (see Hosted features).
- **Integration tokens** — stored locally in `~/.axion/oauth.json` and sent only to the respective service's own API, never to Axion Labs. What each connection can reach, and only when you ask:
  - **GitHub** (`/oauth connect github`) — your repositories, issues, and pull requests (scope `repo read:org read:user`).
  - **Google** (`/oauth connect google`) — Google Drive (list, read, search files) and Google Calendar (list, create, delete events). Axion does **not** request Gmail or email access.
  - **Notion** (`/oauth connect notion`) — the pages and databases you share with the integration token you paste in.
  - **Slack** (`/oauth connect slack`) — the channels and messages available to the bot token you paste in.
  - These connections run as local MCP servers (GitHub, Notion, Slack) or direct API calls (Google). Anything they retrieve becomes part of your prompt context and is then sent to the AI model you selected (see Hosted features).
- **Voice recording** — your microphone is captured to a temporary `.wav` file on your machine via ffmpeg. (Transcription of that audio is a hosted feature — see below.)
- **Session memory** — cross-session memory, learned preferences, and notes are stored in `~/.axion/` on your device.
- **API keys** — keys you supply for third-party providers are stored locally and sent only to that provider.
- **Local models** — if you use Ollama, inference runs entirely on your machine.
- **Chrome extension ↔ CLI bridge** — the browser extension talks to your local Axion CLI over `127.0.0.1` (localhost); that channel never touches the network.

## Hosted features

These send data off your device. In every case the data goes either to a provider
you chose or to Axion Labs' hosted backend — described precisely below.

### AI model inference

Whatever you send to the agent — your prompt, and the file contents, command
output, or page text it includes as context — is transmitted to the model
provider you've selected with `/model`:

- **Third-party providers** (Anthropic, OpenAI, Google Gemini, Groq, Mistral, OpenRouter, and OpenCode) receive your requests directly, authenticated with the API key you supplied. Refer to each provider's own privacy policy for how they handle it.
- **Lumen** (`/model lumen`) routes through Axion Labs' backend on **Cloudflare Workers** (`api.amplifiedsmp.org`), which handles authentication, the free tier, and usage tracking, and forwards the request to **Lumen inference running on Hugging Face**. The free tier is rate-limited (50 requests/day); an API key from [axion.amplifiedsmp.org/keys](https://axion.amplifiedsmp.org/keys) raises this to 1,000/month. Usage is counted per key.
- **IP addresses** are collected during account registration and used to detect duplicate accounts sharing the same IP. If a duplicate IP is detected, the newest account is suspended and the user is offered an opportunity to appeal. IPs are stored in our Cloudflare D1 database and retained for the lifetime of the account.

### Voice transcription and text-to-speech

- **Transcription** — after recording locally, the audio file is uploaded to a cloud Whisper API to be transcribed: **OpenAI** (`whisper-1`) if you have an OpenAI key, otherwise **Groq** (`whisper-large-v3-turbo`). Your spoken audio leaves your device. Transcription is unavailable without one of those keys.
- **Text-to-speech** (`/speak`) — the text to be spoken is sent to **OpenAI's** TTS API. Temporary audio files are deleted after playback.

### Screen vision

When you use screen vision or computer-use features, Axion captures a screenshot
and sends the image to a vision model for description. By default this is
Axion Labs' **`axion-vision` model, hosted on Hugging Face**
(`axionlabsai-lumenvision.hf.space`). If you point vision at another provider with
`/vision`, screenshots go there instead. Either way, images of your screen leave
your device when these features are active.

### Browser control (Chrome extension)

The Axion Chrome extension requests broad browser permissions (`<all_urls>`,
scripting, tabs) so the agent can read page content, click elements, and fill
forms on your instruction. That page data is sent **directly from your browser to
the AI provider you've configured** in the extension (using keys stored in the
browser's local storage) — it is not routed through Axion Labs' servers, unless
you select Lumen, in which case it follows the Lumen path above (Cloudflare →
Hugging Face). The extension only acts on pages when you engage it.

### Training-data contributions (`/contribute`)

Contributing is opt-in — nothing is sent unless you type `/contribute` yourself.
When you do:

- The session is **redacted first**: file contents are stripped, message text is truncated (roughly 1,000 characters per message, 200 per tool result), and only the message structure and metadata remain.
- The redacted session is then **uploaded to Axion Labs' collection endpoint on Cloudflare Workers** (`axion-collect...workers.dev`).
- If that upload fails (e.g. you're offline), the session is instead saved locally to `~/.axion/donations/` as a fallback. Files saved there stay on your disk until you delete them; they are not uploaded automatically later.
- A contribution prompt may appear after long or difficult sessions, but the prompt alone sends nothing — only the `/contribute` command does.
- Run `/contribute optout` to disable the prompts permanently, or `/contribute skip` to dismiss it for the current session.

## Third-party privacy policies

- Hugging Face (Lumen & vision inference): https://huggingface.co/privacy
- Cloudflare (API backend & contribution endpoint): https://www.cloudflare.com/privacypolicy/
- Your configured AI providers (Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, OpenCode): see each provider's policy
- Connected integrations (GitHub, Google, Notion, Slack): see each service's policy

## Your control

- Disconnect any OAuth service with `/oauth revoke <service>`, or delete `~/.axion/oauth.json`.
- Use your own provider keys (or a local model via Ollama) to keep inference off Axion Labs' backend entirely.
- Opt out of contribution prompts with `/contribute optout`, and delete any local files in `~/.axion/donations/` yourself.
- Axion is open source — audit exactly what it does at [github.com/AxionLabsAI/axion](https://github.com/AxionLabsAI/axion).

## Contact

For questions, open an issue at [github.com/AxionLabsAI/axion/issues](https://github.com/AxionLabsAI/axion/issues) or visit [axion.amplifiedsmp.org](https://axion.amplifiedsmp.org).
