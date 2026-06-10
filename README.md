# Forbes Logistix — Backend API

Express 5 API for [forbeslogistix.com](https://www.forbeslogistix.com), deployed as a single Vercel serverless function. Receives the website's form submissions and delivers them as email via Microsoft Graph (`sendMail` as `noreply@forbeslogistix.com`, OAuth2 client-credentials). No database — submissions live in the delivered email (and the sender's Sent Items copy).

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/contact` | General contact form (name, email, message + consent record) |
| `POST /api/lead` | Driver Quick Apply lead (name, US phone, OTR years + TCPA consent record) |
| `POST /api/send-pdf` | **Scaffolding** — kept for the planned full DOT application form; no frontend caller today |
| `GET /` | Health check — returns `Forbes Logistix Backend is Running` |

All POST routes: JSON body (100 kb cap), per-IP rate limiting (5/10 min on contact + lead, 3/10 min on send-pdf), Cloudflare Turnstile verification (skipped only if `TURNSTILE_SECRET` is unset), honeypot fields, input validation, and generic error responses.

## Architecture notes

- `server.js` builds and **exports** the Express app — there is intentionally **no `app.listen()`**. Vercel's runtime serves it via `api/index.js` (the function entrypoint); `vercel.json` rewrites all paths to it.
- Local dev therefore needs `vercel dev` (or a temporary `app.listen()` guard). `npm run dev` alone won't open a port.
- Outbound email: `utils/graphMailer.js` (token caching, timeouts, one retry on definitive failures, `saveToSentItems: true`).
- Turnstile verification: `utils/turnstile.js`, shared by all three controllers.

## Environment variables (values live in Vercel only — never commit them)

| Name | Purpose |
|---|---|
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Azure AD app registration (Graph client-credentials) |
| `GRAPH_SENDER` | Sending mailbox UPN (`noreply@forbeslogistix.com`) |
| `CONTACT_RECEIVER_EMAIL` | Contact-form recipient |
| `LEAD_RECEIVER_EMAIL` | Lead recipient (defaults to `recruiting@forbeslogistix.com`) |
| `CLIENT_RECEIVER_EMAIL` | PDF-application recipient (scaffolding) |
| `TURNSTILE_SECRET` | Cloudflare Turnstile secret; verification is skipped when unset |

## Deploys

Push to `main` → Vercel production deploy at `https://forbes-logistix-backend.vercel.app`. PR branches get preview deployments. The frontend posts to the production URL (constant in the frontend repo).
