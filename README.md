# TranslationPlugin

[简体中文](README_ZH.md)

TranslationPlugin is a Manifest V3 browser extension for translating complete web pages in place. It keeps the original page structure, adds bilingual translations or replaces the original text, and supports both a free Google endpoint and configurable OpenAI-compatible or Claude-compatible AI services.

## Features

- Translate visible page text, common attributes (`placeholder`, `title`, `alt`, and `aria-label`), open Shadow DOM content, and frames where the browser allows extension injection.
- Bilingual mode keeps the source text and inserts the translation next to it. Replace mode shows only the translation and can restore the original page at any time.
- Batch requests, duplicate-text reuse, local result caching, configurable concurrency, retry of failed blocks, and dynamic-content rescanning.
- AI profiles for multiple providers or models, with custom prompts and general, academic, or technical translation styles.
- OpenAI-compatible `/chat/completions` and Claude-compatible `/v1/messages` endpoints.
- Optional browser proxy routing for translation APIs, including Google Translate and configured AI hosts.
- A page badge reports progress and exposes failed-block retry and restore actions.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions` (or the equivalent extensions page in a Chromium-based browser).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository directory.
5. Open the extension settings before using an AI provider.

The extension has no build step and is loaded directly from the source tree. It requires a browser that supports Manifest V3 and the `chrome.proxy` API for optional proxy features.

## Quick start

1. Open a web page and click the extension icon.
2. Choose the target language and translation provider.
3. Click **Translate this page**.
4. Use the page badge to inspect progress, retry failed blocks, or restore the original page.

Google Translate works without an API key, although availability and rate limits depend on the network egress. For AI translation, create a profile in **Settings → AI translation**, enter the endpoint, API key, and model, then select that profile as the active one.

## AI provider configuration

For an OpenAI-compatible service, enter a base URL such as `https://api.example.com` or an existing `/chat/completions` URL. For a Claude-compatible service, enter the service base URL or `/v1/messages` URL. The extension adds the endpoint suffix when needed.

The AI adapter requests numbered output for batches and validates that every input line has a non-empty result. If a provider returns an incompatible format, the extension splits the batch and retries smaller requests. Keep the custom system prompt compatible with the numbered-output requirement when translating a page.

## Proxy routing

The proxy setting supports browser defaults, forced direct connection, a custom proxy for translation APIs only, or a global custom proxy. API-only mode builds a PAC rule for `translate.googleapis.com` and all configured AI profile hosts. Other browser traffic remains direct. If another extension or an enterprise policy controls the browser proxy, this extension cannot override it.

## Troubleshooting

- **Some text is missing:** make sure the text is visible when translation starts. Menus and content revealed later are rescanned after clicks and focus changes; highly dynamic pages may still require another scan.
- **Very long pages:** a pass processes up to 1,500 text units. If that limit is not reached, it can also process up to 300 translatable attributes.
- **The page appears unchanged:** inspect the page badge for failed blocks and retry them. A provider timeout, rate limit, invalid API key, or proxy rule can affect only part of a page.
- **AI translation is slow:** reduce AI concurrency, reduce the size of custom prompts, and verify that the API host matches the proxy rule. Requests have a bounded timeout and retry transient failures.
- **IEEE Xplore or similar component-heavy pages:** use bilingual mode first. Complex layouts, framework rerenders, fixed-height containers, and closed Shadow DOM can limit where a translation can be inserted.

## Privacy and data handling

Translation text is sent to the selected provider. API keys and settings are stored in the browser's local extension storage. The extension does not include a telemetry service. Do not use a provider or custom proxy that you do not trust with the page content being translated.

## Development

The extension is organized into four areas:

- `content/` collects page text, calls the translation bridge, writes translations, observes dynamic changes, and restores the source DOM.
- `background/` owns provider calls, caching, retries, usage accounting, and proxy settings.
- `popup/` contains the per-page controls.
- `options/` contains persistent provider, language, proxy, and usage settings.

The project currently has no package manager or build step. Use a Chromium extension reload after source changes. The main runtime files are plain JavaScript ES modules where supported by the Manifest V3 service worker.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
