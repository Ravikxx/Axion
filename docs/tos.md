# Terms of Service

**Last updated: July 19, 2026**

## Overview

These Terms of Service ("Terms") govern your use of the Axion web chat, API, CLI-hosted features, and related services (collectively, the "Service") provided by Axion Labs. By using the Service, you agree to these Terms.

## Service description

The Service provides access to AI models and developer tools. Lumen requests are routed through Axion Labs' hosted backend to model infrastructure on Hugging Face. The CLI can also connect directly to third-party AI providers that you configure. Features, models, limits, and availability may change. The Service is provided on an "as is" basis.

## Accounts

- You may use limited parts of the Service without an account.
- You are responsible for your account credentials and Axion-issued API keys.
- Do not publish, sell, or share an Axion-issued API key outside its intended use.
- **One account per person.** Accounts detected sharing an IP address with another verified account may be suspended. If you believe this is an error, you may use the appeal link in the suspension email.

## Usage, plans, and billing

- Without an API key, Lumen is limited to 50 requests per day per IP address.
- A Free account includes an account-wide $0.125 weekly usage allowance and a $0.05 allowance per rolling two-hour window, with up to three active API keys. Both allowances are lazy-start: a period doesn't begin, or count down toward reset, until your account's first chargeable request after the previous one has fully elapsed.
- Pro costs $7 per month through Square and includes an account-wide $1.25 weekly usage allowance and a $0.50 allowance per rolling two-hour window, with unlimited active API keys.
- Included usage is measured from input and output tokens. The current accounting rates are $0.15 per million input tokens and $0.50 per million output tokens.
- Redeemable API credits are used after the included allowance. Credit balances and USD usage values are service accounting units, have no cash value, and cannot be withdrawn. Variable-value administrative credit codes may be redeemed in $0.001 increments.
- Square processes checkout and card details. Axion stores the identifiers and subscription status needed to provide the plan, but does not receive or store your full card number.
- Prices, allowances, rate limits, and availability may change. Free access is intended for individual, non-commercial use and may be restricted or revoked for abuse.

## Acceptable use

You agree not to:

- Use the Service for any illegal purpose or in violation of applicable law.
- Bypass or attempt to bypass usage limits, authentication, payment, or access controls.
- Reverse engineer, decompile, or extract hosted model weights.
- Use the Service to generate harmful, abusive, or deliberately misleading content.
- Automate requests in a way that degrades the Service for others.
- Resell or repackage free included usage as a paid service.

## Third-party providers

Depending on the feature you use, content may be processed by Hugging Face, an AI provider you configure, Cloudflare, Square, or Resend. Their handling of data is also governed by their own terms and privacy policies. See the [Privacy Policy](/privacy) for the providers used by each feature.

## Data handling

- Prompts and relevant context are transmitted to the selected model provider to generate responses.
- Signed-in web chat history is stored in Axion's hosted database so it can sync across sessions. Local CLI history and browser data may also remain on your device.
- Axion stores the account, authentication, usage, billing, API-key, credit, and service records needed to operate the Service.
- Axion does not use your conversations for training unless you explicitly opt in with `/contribute`. A contributed session is handled as described in the [Privacy Policy](/privacy).
- Provider keys that you configure in the CLI or extension remain in their documented local storage. Axion-issued API keys are stored by the hosted backend so they can authenticate requests.

## Disclaimer

THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. Axion Labs disclaims all warranties, including merchantability, fitness for a particular purpose, and non-infringement.

## Limitation of liability

Axion Labs shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service.

## Termination and suspension

We may suspend or terminate access for a violation of these Terms, abuse, risk to the Service or other users, or as otherwise necessary to operate the Service. Suspended accounts may use the appeal link in the suspension notice.

## Changes

These Terms may be updated from time to time. Continued use of the Service after changes take effect constitutes acceptance of the updated Terms.

## Contact

For questions, open an issue at [github.com/AxionLabsAI/axion/issues](https://github.com/AxionLabsAI/axion/issues) or visit [axion.amplifiedsmp.org](https://axion.amplifiedsmp.org).
