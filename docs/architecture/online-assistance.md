# Optional OpenAI assistance

The offline core is the default. Settings → Connect OpenAI verifies a user-owned API key against the selected model without sending user content. The default model is `gpt-6-astra`; users may select another API model supporting Structured Outputs and image inputs. Model-list access is verified at connection time; actual generation capability and quota are checked by the first request. This feature uses the OpenAI Platform API and its billing, not a consumer ChatGPT login.

## User controls

- Connect stores an OS-encrypted key in `online-ai-connection-v1.json` under Electron's user-data directory. Stored keys never return through IPC, appear in renderer status, or enter SQLite/exports. Linux's plaintext fallback is rejected. Disconnect and Delete all local data remove the connection and cancel active work.
- “Use OpenAI for complex assistant requests” is a separate, initially unchecked choice. When enabled, the existing fallback route uses OpenAI. Deterministic requests stay local. Bounded recent conversation, approved profile information and a scoped calendar fact packet can be shared. The assistant displays a connected indicator.
- “Send pages to OpenAI” in document review explicitly authorizes the displayed pages and their source text. Merely connecting or importing a file never uploads a page. Main checks the active selection and source digest; closing review cancels the request. Existing edits/selections survive online review.

## Validation and failure behavior

All calls execute in Electron main against fixed HTTPS OpenAI endpoints, with redirects rejected, a 60-second generation timeout, a 512 KB response ceiling, and cancellation. Requests use the Responses API with strict JSON schemas, no tools, and `store: false`. Optional output fields become required/nullable on the wire. The app still validates output with Zod, source spans, fact placeholders, and the deterministic calendar engine. Neither model has direct calendar write access. Incomplete/refused/invalid responses are rejected as a whole. Empty actions/groups mean abstention, not invented events. HTTP errors use bounded local messages; provider error bodies are never displayed or logged.

Document assistance currently checks coverage gaps against existing OCR/PDF blocks and high-detail page images. It cannot recover missing characters or invent new OCR evidence, and it does not upload a full PDF as a file. All source-backed suggestions join the ordinary review, selected bulk save, duplicate reconciliation and undo workflow. The current coverage pass is bounded to eight source windows; large documents may require another pass or manual corrections. AI accuracy is not guaranteed.

Automated tests use a mock HTTP transport and test keys. No live account, quota, billing or model-quality result is claimed without a real user-configured API connection. Standard build and offline smoke disable the online adapter.

## ChatGPT account feasibility

OpenAI documents ChatGPT-managed sign-in through the [Codex App Server](https://learn.chatgpt.com/docs/app-server). That is a separate embedded runtime integration, with account eligibility, runtime isolation and packaging work. This change implements the direct API option. It does not collect ChatGPT passwords/cookies, reuse another application's credentials, or advertise ChatGPT subscription access as API credit.

Official references checked September 2026: [API authentication](https://developers.openai.com/api/reference/overview), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [file and PDF inputs](https://developers.openai.com/api/docs/guides/file-inputs), [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra).
