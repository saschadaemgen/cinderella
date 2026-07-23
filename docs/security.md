# Cinderella — Security Posture

> _Living document — Cinderella, Seasons 1–3. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S3-014**._

_Living document. Ground truth is the code; every claim below is anchored to a
repo-relative `file:line`. Where the project outline and the code diverge, the
code wins and the divergence is called out inline with a **Note:**._

Cinderella's admin console is **hostile-facing by design**: it is published on the
public internet at the admin hostname over real Let's Encrypt TLS, and it is
secured by **what you have** (a passkey) rather than by network location. This
document records the full security surface of that console, verified against the
implementation.

---

## 1. Network shape: appless public console over TLS

- **nginx terminates TLS and reverse-proxies to Fastify on `127.0.0.1`.** The app
  binds the loopback interface only: `app.listen({ host: '127.0.0.1', port: deps.adminCfg.adminPort })`
  (`src/web/server.ts:243`), default port `8787` (`src/config.ts:135`,
  `deploy/nginx-admin.conf:54`).
- **Let's Encrypt TLS at the edge.** The vhost listens on 443 with
  `ssl_certificate .../fullchain.pem` and redirects all port-80 traffic to HTTPS
  except the ACME challenge path (`deploy/nginx-admin.conf:18-46`). Certs are
  issued with `certbot certonly --nginx` (`deploy/nginx-admin.conf:9`,
  `deploy/RUNBOOK.md:83`).
- **Why public + TLS rather than a bare IP:** WebAuthn requires a secure context
  and a domain-based Relying Party ID; a bare IP or plain HTTP would not work.
  The RP ID is derived from the host of `PUBLIC_ORIGIN` (`src/config.ts:158-167`;
  see also the header comment in `deploy/nginx-admin.conf:14-15`).
- **`trustProxy` is pinned to `'loopback'`** (`src/web/server.ts:82`) so only the
  local nginx hop is trusted for `X-Forwarded-For`; `req.ip` therefore reflects
  the real client (`X-Real-IP`/`X-Forwarded-For` set in
  `deploy/nginx-admin.conf:56-58`). The console surfaces this as a non-editable
  "pinned" status row (`src/web/views/security.ts:508-509`).
- **Host header safety:** the vhost matches only its exact `server_name` and is
  not `default_server`, so unknown Host headers never reach Cinderella
  (`deploy/nginx-admin.conf:49-51`).
- **Edge backstops:** nginx also adds `Strict-Transport-Security` and
  `X-Robots-Tag: noindex, nofollow` (`deploy/nginx-admin.conf:46-47`) and caps
  request bodies at `client_max_body_size 1m` (`deploy/nginx-admin.conf:60`).

> **Note:** the outline calls the console "appless." Confirmed in the narrow
> sense that there is **no SPA** — every page is server-rendered HTML. It is not,
> however, script-free. There are **three** static, CSP-compliant
> (`script-src 'self'`) client scripts, all served from `/assets/`:
> `/assets/htmx.min.js`, loaded on **every** page for hypermedia interactions
> (`src/web/html.ts:157`; the body carries `hx-headers`, `src/web/html.ts:171`),
> plus `/assets/webauthn-browser.js` and `/assets/auth.js`, loaded on every
> chrome page (`src/web/html.ts:160-161`) and injected directly on the
> chrome-less login page (`src/web/security/routes.ts:147-148`). htmx is a small
> hypermedia library, not an SPA framework — but a description of "only two
> scripts on the login/security pages" would understate what actually ships.

---

## 2. Authentication

### 2.1 Passkeys (WebAuthn) — the primary factor

Implemented natively with `@simplewebauthn/server` (`src/web/security/webauthn.ts:12-18`).

- **Usernameless, discoverable-credential login.** Authentication options are
  generated with an empty `allowCredentials`, so the user picks any resident key
  (`src/web/security/webauthn.ts:197-203`).
- **RP-ID/origin startup guard (CCB-S2-011).** A passkey is bound by the authenticator
  to the RP ID it was created under, so if the RP ID ever stops matching the WebAuthn
  origin's host, `navigator.credentials.get()` rejects every existing credential with a
  client-side `NotAllowedError` — a silent operator lockout. `validateRpConfig`
  (`src/config.ts`) now runs in `loadAdminConfig` and refuses to boot unless `WEBAUTHN_RP_ID`
  equals the `WEBAUTHN_ORIGIN`/`PUBLIC_ORIGIN` host (or a registrable parent of it),
  turning that silent lockout into a loud config error. The effective RP ID/origin are
  also logged at startup (public hostnames, not secrets) so a future diagnosis is one
  `grep` away. Verified in `scripts/verify-admin.ts` (match/parent pass; mismatch rejected).
- **Ceremonies** (all in `src/web/security/routes.ts`): login options/verify
  (`/webauthn/login/options`, `/webauthn/login/verify` — lines 188-231),
  authenticated registration (`/webauthn/register/*` — lines 311-340), and
  step-up re-verification (`/webauthn/stepup/*` — lines 343-366).
- **Challenges** are held server-side in a short-lived in-memory store keyed by a
  random id carried in a signed, HttpOnly, `SameSite=Strict` cookie (`cinderella_wa`,
  5-minute TTL — `src/web/security/routes.ts:27-46`, `src/web/security/webauthn.ts:49-82`).
  > **Note:** unlike sessions (PostgreSQL-backed, §5), the WebAuthn challenge
  > store is **in-memory and single-process** (`src/web/security/webauthn.ts:57-58`).
  > This is safe because the app is one process (per the architecture decision in
  > `CLAUDE.md`) and challenges live only for the seconds of a ceremony.
- **Registered credentials** are stored in `webauthn_credentials`
  (`migrations/006_webauthn.sql:4-22`): COSE public key, monotonic signature
  counter, transports, AAGUID, operator label, backed-up flag, device type, and a
  `locked` flag.

### 2.2 Argon2id break-glass password — the fallback

- A configurable **break-glass** path (`POST /login`), gated by the
  `breakGlass.enabled` setting (`src/web/security/routes.ts:234-302`).
- Password verification uses `argon2.verify` and **always runs a hash comparison
  even for a wrong username** (against the real hash) so timing does not reveal
  whether the username exists (`src/web/auth.ts:112-125`).
- The username comparison is constant-time (`src/web/auth.ts:97-105,117`).
- The operator hash is env-only (`ADMIN_PASSWORD_HASH`, must start with
  `$argon2id$` — `src/config.ts:141-146`); it is never stored in the database or
  rendered.
- **Bootstrap safety:** break-glass defaults to `enabled: true`
  (`src/security/settings.ts:91`) so a fresh install can log in and register
  passkeys; the console **refuses to disable it while zero passkeys are
  registered** (`src/web/views/security.ts:585-590`) and warns until ≥2 passkeys
  exist (`src/web/views/security.ts:156-164`).

### 2.3 Optional TOTP second factor (on the break-glass path only)

- When `breakGlass.totpRequired` is set, the password path also verifies a TOTP
  code (`src/web/security/routes.ts:273-277`, `src/web/auth.ts:127-135`, `otplib`
  with ±1 step tolerance).
- The TOTP secret lives in a single-row `admin_totp` table
  (`migrations/006_webauthn.sql:27-32`); only its **enabled status** is ever
  rendered, never the secret (`src/web/views/security.ts:229-231`).
- Enroll/enable/disable flows with a QR code are in
  `src/web/views/security.ts:683-712`.

> **Note on migration numbering:** the outline lists "006 webauthn + TOTP · 007
> admin sessions." The actual files are `migrations/006_webauthn.sql` (which
> contains **both** `webauthn_credentials` and `admin_totp`) and
> `migrations/007_sessions.sql`. Content matches the outline; only the file names
> are shorter.

---

## 3. Hardening controls (all admin-configurable, persisted, audited)

Every control below is a real, validated field in `SecuritySettings`
(`src/security/settings.ts:23-74`), normalized from untrusted input with
secure-default fallbacks (`normalizeSecurity`, `src/security/settings.ts:153-223`),
persisted in the `settings` table under the `security` key, and **audited on every
change** (`SecurityService.save` writes a `security.update` audit entry —
`src/security/settings.ts:248-253`). The Security console renders one card per
control (`src/web/views/security.ts`).

### 3.1 Session policy — present

- Idle timeout (sliding), absolute max age, concurrent-session policy, and
  step-up toggle (`src/security/settings.ts:37-44`, defaults at lines 92-97: 12 h
  idle, 24 h absolute, step-up off, multiple sessions).
- Enforced in the session store: expiry is checked and slides on every access
  (`src/web/session.ts:85-94`); a `single` policy drops all other sessions on new
  login (`src/web/security/routes.ts:161-163`, `src/web/session.ts:105-111`).
- The console exposes a "log out other sessions" action showing the active count
  (`src/web/views/security.ts:341-352,715-721`).

### 3.2 Step-up re-verification — present

- When `session.stepUpForSensitive` is on, **sensitive mutations require a fresh
  passkey re-verification** within a 5-minute window (`STEP_UP_WINDOW_MS`,
  `src/web/security/routes.ts:25`). Enforced in the `preHandler` hook
  (`src/web/server.ts:181-187`), which returns `403` with an
  `x-step-up-required: 1` header so the UI can prompt.
- "Sensitive" = any state-changing request **except** `/logout` and the WebAuthn
  ceremonies (`isSensitive`, `src/web/server.ts:72-78`).
- **Never locks out bootstrap:** step-up is skipped when zero passkeys exist
  (`src/web/server.ts:183`). The same rule is mirrored in the **server-side view
  helper** `needsStepUp` (`src/web/security/stepup.ts:13-21`), which the security
  page uses during rendering to decide whether to show a proactive step-up
  prompt — it is server-rendered logic, not client-side JavaScript.

### 3.3 Rate limiting & lockout — present

Two independent limiters (`src/web/auth.ts`), both reading live settings:

- **Per-client login lockout** (`LoginRateLimiter`, `src/web/auth.ts:28-68`):
  after `loginMaxAttempts` failures within `loginWindowMinutes`, the client is
  locked for `lockoutMinutes` (defaults 5 / 15 / 15 —
  `src/security/settings.ts:98-103`). Enforced on both the passkey verify path
  (`src/web/security/routes.ts:195-197,212`) and the password path
  (`src/web/security/routes.ts:247-249,280`).
- **Global request-rate limiter** (`GlobalRateLimiter`, `src/web/auth.ts:71-95`):
  optional per-client requests/minute (`globalPerMinute`, `0` = off; default off).
  Enforced in the `onRequest` hook, with `/assets/` excluded so the UI still
  loads (`src/web/server.ts:141-144`). Over-limit requests get `429`.

### 3.4 IP allow/deny — present

- Optional allowlist/denylist for the admin surface (`ipAccess.mode` + `list`,
  `src/security/settings.ts:52-56`; default `off`). Enforced in `onRequest`, with
  `/healthz` and `/assets/` exempt (`src/web/server.ts:146-153`); blocks return
  `403` and log a warning.
- Matching supports IPv4 (+CIDR) and IPv6 (exact or CIDR prefix); malformed rules
  never match (`src/web/security/access.ts`).
- **Deliberately off by default:** the module header and the UI both note it is
  unsuitable for the operator's dynamic CGNAT/Starlink address — passkeys are the
  real control (`src/web/security/access.ts:1-3`, `src/web/views/security.ts:390-393`).

### 3.5 CSP & security headers — present

- Applied to **every response** via an `onSend` hook (`src/web/server.ts`,
  `src/web/security/headers.ts:9-23`), with two carve-outs: the public surfaces
  (archive front + marketing site) set their own headers, and static `/assets/*`
  files get `Cache-Control: public, max-age=86400` + `nosniff` instead of the
  admin `no-store` set (CCB-S3-001 — the site's self-hosted webfonts would
  otherwise re-download on every navigation).
- Always set: `Content-Security-Policy` (configurable), `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` (configurable),
  `Cache-Control: no-store`, optional `Permissions-Policy`, and `Strict-Transport-Security`
  when `hstsMaxAge > 0`.
- **Default CSP is strict** (`DEFAULT_CSP`, `src/security/settings.ts:77-79`):
  `default-src 'self'`, `script-src 'self'` (no inline JS), `frame-ancestors
'none'`, `form-action 'self'`, `base-uri 'none'`. `style-src` permits
  `'unsafe-inline'` (Tailwind utility classes); scripts do not. The login page
  comment confirms the no-inline-JS constraint drives the external `auth.js`
  (`src/web/security/routes.ts:82`).
- HSTS defaults to a 2-year max-age with `includeSubDomains`, preload off
  (`src/security/settings.ts:105-112`). The console offers a one-click "reset CSP
  to secure default" (`src/web/views/security.ts:451-457,625-627`).

### 3.6 Audit log — present

- `audit_log` table (`migrations/003_admin.sql:12-21`): who / what / when /
  target / details, indexed by time.
- Written by `writeAudit` (`src/db/audit.ts:17-29`) across the auth and security
  flows — logins, failed logins, step-ups, passkey register/rename/revoke,
  counter-regression, TOTP changes, and every settings save.

### 3.7 Security-event feed — present

- The Security page renders a **"Security events"** card: the 200 most recent
  audit rows filtered to `auth.` / `passkey.` / `security.` actions, showing the
  latest 40, with anomalies (counter regression, lockout, failed login, rejected
  registration) highlighted (`src/web/views/security.ts:76-78,519-537`).

### 3.8 Webhook alerting — present (narrow)

- `alertSecurityEvent` posts a compact JSON payload to a configured HTTPS webhook,
  best-effort with a 5-second timeout; failures are swallowed so they can never
  break the auth path (`src/web/security/alert.ts`). Off when no URL is set; the
  URL is validated to `https://` on save (`src/security/settings.ts:165-166`).
- > **Note:** the outline implies broad "security-event alerting." In code the
  > webhook fires for exactly **two** events: passkey **counter regression**
  > (`src/web/security/routes.ts:217-222`) and login **lockout**
  > (`src/web/security/routes.ts:291`). Other security events reach the audit log
  > and the on-page feed (§3.6-3.7) but do **not** trigger a webhook.

### 3.9 Counter-regression auto-lock — present

- A valid assertion whose signature counter did not advance is treated as a
  cloned-authenticator signal. On that signal the credential is **automatically
  locked**, the event is audited, and an error is logged
  (`completeAuthentication` catch branch, `src/web/security/webauthn.ts:246-267`;
  helper `isCounterRegression` at lines 89-91).
- The login route then fires the webhook alert and returns a
  "This passkey was locked (security anomaly)" `403`
  (`src/web/security/routes.ts:217-222`). A locked credential is refused up front
  on subsequent attempts (`src/web/security/webauthn.ts:221`) and shown as
  `locked` in the passkey list (`src/web/views/security.ts:114`).

### 3.10 Passkey policy & AAGUID allowlist — present (beyond the outline)

- **User verification** is configurable and applied to **both** the registration
  and authentication ceremonies (`src/web/security/webauthn.ts:116,145,200,229`).
  The **resident-key requirement** and **attestation conveyance** are also
  configurable but applied **only at registration** — the usernameless
  authentication ceremony sends neither (`src/security/settings.ts:24-30`,
  `src/web/security/webauthn.ts:98-121` vs `192-203`).
- An optional **AAGUID allowlist** restricts which authenticator models may
  register; a non-allowlisted model is rejected and audited
  (`src/web/security/webauthn.ts:156-165`).
- > **Note:** `attestation` accepts `none | indirect | direct` in settings
  > (`src/security/settings.ts:19`), but the library helper maps `indirect` down
  > to `none` — only `direct` requests attestation
  > (`src/web/security/webauthn.ts:93-96`).

### 3.11 Argon2 cost settings — present but not applied at runtime

- Memory/time/parallelism are configurable (`src/security/settings.ts:65-69,113`).
- > **Note:** these values do **not** affect live password verification. Runtime
  > verification uses the pre-computed `ADMIN_PASSWORD_HASH` from the environment
  > (`src/web/auth.ts:112-124`); the console itself states the cost is applied by
  > the `npm run hash-password` tool the next time the break-glass password is set
  > (`src/web/views/security.ts:466-469`). The setting is guidance for that tool,
  > not a live control.

---

## 4. CSRF protection

- **Every state-changing request** (POST/PUT/PATCH/DELETE) is guarded in the
  `preHandler` hook, which rejects with `403 invalid csrf token` unless a valid
  session and token are present (`src/web/server.ts:172-178`). `/login` and the
  WebAuthn login ceremony carry their own guards and are exempted here
  (`src/web/server.ts:175`).
- **`csrfOk` accepts the token from either the `x-csrf-token` header or a `_csrf`
  body field**, compared to the session's token in constant time
  (`src/web/session.ts:172-190`). Forms embed `_csrf` as a hidden input
  (e.g. `src/web/views/security.ts:97-98`); htmx requests carry the header via the
  body-level `hx-headers` attribute (`src/web/html.ts:171`).
- The pre-session break-glass login uses a separate **double-submit** token: a
  signed, HttpOnly, `Path=/login` cookie (`cinderella_login_csrf`) compared
  constant-time to the submitted `_csrf` (`src/web/security/routes.ts:48-59,258-270`).

---

## 5. Sessions: PostgreSQL-backed

- Sessions are persisted in the `admin_sessions` table
  (`migrations/007_sessions.sql:8-19`) so they **survive `systemctl restart` and
  deploys** — previously an in-memory store logged the operator out on every
  restart (`src/web/session.ts:1-10`, `migrations/007_sessions.sql:1-6`).
- The session id lives in a **signed cookie** (HMAC with the fixed
  `SESSION_SECRET`) with flags **HttpOnly, Secure, SameSite=Strict, Path=/**
  (`src/web/session.ts:157-166`; rendered as a status row at
  `src/web/views/security.ts:510-511`).
- Idle expiry slides on each request; an absolute max age also applies; both are
  admin-configurable (`src/web/session.ts:85-94`, §3.1). A background sweeper
  reaps abandoned expired rows every 30 minutes (`src/web/server.ts:237-242`).
- A passkey login records a fresh step-up timestamp; a password login does not
  (`src/web/session.ts:67-68`).

---

## 6. Media is served only behind authentication

- `/media/` is a static mount (`src/web/server.ts:119-124`).
- The `onRequest` auth guard's **public allowlist is exactly**: `/login`,
  `/healthz`, `/favicon.ico`, `/assets/*`, and `/webauthn/login/*`
  (`src/web/server.ts:157-162`). **`/media` is not in that set**, so any
  unauthenticated request for media is redirected to `/login` (GET) or gets `401`
  (`src/web/server.ts:163-168`).
- This matters for the consent model: captured member media is not publicly
  reachable through the admin console. (The future public archive/embed surface
  is a separate, later-season concern — see `CLAUDE.md` "Parked.")

---

## 7. Network scoping without a host-wide firewall

- Cinderella runs on a **shared VPS**; the runbook explicitly forbids imposing a
  host-wide firewall that could break neighbouring services
  (`deploy/RUNBOOK.md:7-9,173-177`).
- Protection is therefore **bind-level**: the admin server binds `127.0.0.1:8787`
  (`src/web/server.ts:243`) and PostgreSQL is reached at `127.0.0.1:5432`
  (`deploy/RUNBOOK.md:44,175-176`). The only public entry point is nginx on
  443/80, which proxies to loopback. Cinderella opens no other public port; the
  SimpleX core runs in-process with no exposed port (`CLAUDE.md` architecture).

---

## 8. Secrets: environment-only, never in repo or logs

- Boot/secret configuration is environment-only: `DATABASE_URL`, `SESSION_SECRET`
  (≥32 chars, enforced), `ADMIN_PASSWORD_HASH` (Argon2id, enforced),
  `ADMIN_USERNAME` (`src/config.ts:141-181`). None are ever stored in the
  `settings`/`security` tables (`src/security/settings.ts:5-8`).
- In production these live in a root-owned `0600` systemd `EnvironmentFile`
  (`deploy/RUNBOOK.md:16,38-53`); in development, a git-ignored `.env`
  (`src/config.ts:1-15`).
- **Log redaction:** `redactConfig` masks the DB password in the userinfo and in
  credential-bearing query params, and refuses to emit an unparseable connection
  string (`src/config.ts:186-212`). The TOTP secret and session secret are never
  rendered; the security settings model is explicit that secrets are never stored
  or rendered there (`src/security/settings.ts:5-8`).

---

## 9. Control inventory (outline ↔ code)

| Control (outline)                                                 | In code?            | Anchor                                                   |
| ----------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| Public console over Let's Encrypt TLS (nginx → Fastify 127.0.0.1) | Yes                 | `deploy/nginx-admin.conf:31-61`, `src/web/server.ts:243` |
| Passkey (WebAuthn) primary auth                                   | Yes                 | `src/web/security/webauthn.ts`, `routes.ts:188-231`      |
| Argon2id break-glass password                                     | Yes                 | `src/web/auth.ts:112-125`, `routes.ts:234-302`           |
| Optional TOTP (break-glass only)                                  | Yes                 | `src/web/auth.ts:127-135`, `routes.ts:273-277`           |
| Session policy (idle/absolute/concurrent)                         | Yes                 | `src/web/session.ts:85-111`, `settings.ts:37-44`         |
| Step-up before sensitive actions                                  | Yes                 | `src/web/server.ts:181-187`, `routes.ts:25`              |
| Rate-limit & lockout                                              | Yes                 | `src/web/auth.ts:28-95`, `server.ts:141-144`             |
| IP allow/deny                                                     | Yes                 | `src/web/security/access.ts`, `server.ts:146-153`        |
| CSP & security headers                                            | Yes                 | `src/web/security/headers.ts`, `settings.ts:77-79`       |
| Audit log                                                         | Yes                 | `migrations/003_admin.sql:12-21`, `src/db/audit.ts`      |
| Security-event feed                                               | Yes                 | `src/web/views/security.ts:519-537`                      |
| Webhook alerting                                                  | Yes (2 events only) | `src/web/security/alert.ts`, `routes.ts:217-222,291`     |
| Counter-regression auto-lock                                      | Yes                 | `src/web/security/webauthn.ts:246-267`                   |
| PostgreSQL-backed sessions                                        | Yes                 | `migrations/007_sessions.sql`, `src/web/session.ts`      |
| Media behind auth (`/media` not public)                           | Yes                 | `src/web/server.ts:119-124,157-162`                      |
| Bind-level scoping (no host firewall)                             | Yes                 | `src/web/server.ts:243`, `deploy/RUNBOOK.md:173-177`     |
| Secrets in on-VPS env (EnvironmentFile)                           | Yes                 | `src/config.ts:141-181`, `deploy/RUNBOOK.md:38-53`       |
| CSRF (header or `_csrf` body)                                     | Yes                 | `src/web/session.ts:172-190`                             |

Everything the outline claims is present in code. The material nuances to keep in
mind are the two flagged above: **webhook alerting fires for only two event
types** (§3.8), and the **Argon2 cost setting is tooling guidance, not a live
verification control** (§3.11). Two further precision fixes applied to this draft:
the console is script-free only in the "no SPA" sense — `htmx.min.js` is loaded
site-wide (§1) — and resident-key/attestation policy is applied at registration
only, not on the authentication ceremony (§3.10).

---

## 9a. Natural addressing — the consent-safety controls (CCB-S3-002)

Letting members instruct Cinderella in plain language widens the attack surface on the one
thing that must never be wrong: **who consented to what**. The controls below exist for that
reason and are verified in [`scripts/verify-interaction.ts`](../scripts/verify-interaction.ts).

| Risk | Control | Anchor |
| --- | --- | --- |
| A misread sentence publishes someone | **PUBLISH/UNPUBLISH always require an explicit affirmative** inside the follow-up window. Understanding is generous; acting is not. | `src/interaction/engine.ts` (`dispatch`, `performConsentChange`) |
| Publishing on someone else's behalf | Any instruction carrying a third-person pronoun, an `@mention`, a capitalised possessive, or an unknown capitalised name is **refused**, with no action taken — admin or not | `src/interaction/rules.ts` (`findTargetName`), `engine.ts` |
| Privilege escalation through the bot | **There is no admin concept in this path.** The member id acted on is always `msg.senderMemberId`; no call shape reaches another member's consent | `src/consent/apply.ts`, `src/db/consent-actions.ts` (`undoLastConsentAction`) |
| A future AI resolver inventing authority | The catalog is **closed and re-validated at the seam**: an out-of-catalog intent, an out-of-range confidence, or a throw becomes UNKNOWN / falls back to the rules | `src/interaction/resolver.ts` (`sanitize`) |
| Discussion of the bot triggering the bot | Strict first-standalone-word anchoring; suffixed forms rejected before fuzzy matching; hypothetical and quotation guards | `src/interaction/addressing.ts`, `rules.ts` |
| Negated instructions acted on literally | A negation beside the matched keyword collapses confidence — she asks rather than acts | `rules.ts` (`negatedNear`) |
| A forwarded message opening a consent prompt | Forwarded items never reach the interaction layer, checked before addressing (CCB-S3-005). Measured: the first 240 characters of the live announcement resolve to PUBLISH at 0.94 | `src/interaction/engine.ts`, `src/capture/message.ts` |
| Her interjecting on text that merely starts with her name | UNKNOWN is answered only on a strong address signal; a length guard ignores long text without a high-confidence intent | `engine.ts` |
| Guards failing silently and unnoticed | Every ignored candidate is recorded and shown in the console | `src/interaction/near-misses.ts` |
| Ordinary conversation being acted on | Inside the follow-up window the confidence bar rises to 0.8, above a lone keyword's score | `engine.ts` (`IMPLICIT_MIN_CONFIDENCE`) |
| Flooding a group through the bot | Reply rate limits per member and per chat; nickname anti-spam silence | `src/interaction/state.ts` |
| A disabled toggle half-applying | Command-shaped text (`/…`) never enters the conversational path | `engine.ts` |
| Silent consent changes | Consent OUTCOME replies bypass the rate limiter, so a change is never made without saying so; failures are logged and raised to the runtime status | `engine.ts` (`ReplyOptions.bypassLimit`) |

**Plugin API keys (CCB-S3-004).** Provider keys are encrypted at rest with AES-256-GCM under a
key derived from `SESSION_SECRET` via scrypt, because the `settings` table ends up in every
database backup. The admin field is WRITE-ONLY: it renders no value, saving it blank keeps the
stored key, and clearing is an explicit checkbox. Keys never appear in logs or audit entries —
the audit detail records only whether a key is set. Rotating `SESSION_SECRET` makes stored
plugin keys undecryptable and they must be re-entered; that is the deliberate trade for not
introducing a second operator-managed secret.

**Outbound calls (CCB-S3-004).** The price feature is the instance's only egress. It sends
canonical asset ids and a currency code to the configured provider and nothing else — no
member id, no message text, no group identity. Responses are not trusted: a bad status, a
timeout or a missing price is a failure, never a zero. Volume is bounded by the quote cache
and a dedicated per-member/per-chat price budget. The feature can be switched off entirely.

**Untrusted input handling.** The search slot reaches Postgres only through
`websearch_to_tsquery` as a bind parameter and only against `published_messages`
(`src/db/public-archive.ts`), so a member's search can neither be injected nor reveal that an
unpublished message exists. Slots are length-capped at the seam (query 200, name 80 chars).

**Conversation state is deliberately not persisted.** Follow-up windows, pending confirmations
and retort history live in process memory and are lost on restart (`src/interaction/state.ts`).
That costs a member one repeated wake word and avoids keeping a durable side-channel record of
who spoke to the bot and when. Consent itself is in PostgreSQL, journalled with its provenance
(D-032).

**Admin surface.** `/interaction` sits behind the same session, CSRF, step-up and IP controls
as every other admin page, and every save writes an `interaction.update` audit entry.

---

## 9b. Her own messages — the consent leak guard (CCB-S3-007)

Publishing Cinderella's replies opens a route around the consent gate that member
messages do not have: **her words can contain a member's name.** The mention
prefix names the sender; a third-party refusal names whoever the instruction
pointed at. Publishing either would put a non-consenting member's name into the
public archive through her message.

**The guard is in the publication derivation** (`published_messages`, migration
013), deliberately not at composition time. Two consequences follow, and both are
the point:

- a reply type added later cannot bypass it, because nothing is baked in at send
  time;
- it is **re-evaluated on every read**, so when a named member unpublishes, their
  name disappears from messages of hers that were already public.

`redact` (default) replaces the name with a localised persona string; `withhold`
suppresses the whole message. A name that resolves to **no** member, or to **more
than one**, is treated as non-consenting — there is no consent to point at, so it
is redacted rather than gambled on.

**Full-text search is closed separately.** A generated column cannot consult the
`consent` table, so her rows are indexed from `search_body`, which has every named
member replaced unconditionally. Slightly more is hidden from search than from the
page, which is the right way round: otherwise a visitor could search a redacted
name, get the card back, and learn that it names them. Her rows index
`search_body` **and nothing else** — a bot row without one is unsearchable rather
than silently indexed in the clear, and a CHECK constraint rejects it outright.

**`raw_json` was removed from `published_messages`.** For a quoting reply the raw
chat item contains the quoted member's full text and profile. Nothing read it
publicly, and now nothing can.

**Two defaults depart from the briefing, both toward publishing less.** Her
`status` answer states how many of a member's messages are *not* public, and her
`search` answer repeats the member's own query text verbatim. Neither is covered
by any consent, and redacting a name does not remove either. Both ship excluded
and stay switchable, with the admin help text saying what enabling them means.

**Hostile input.** Display names are member-controlled and end up in a regular
expression. They are escaped by `escapeRegex` in TypeScript and stored
pre-escaped, after it was verified against real Postgres that escaping inside SQL
does *not* survive the trip through the replacement grammar — a name like
`Ro[b]in.*` produced an invalid backreference, which is redaction failing open.
The replacement string is operator-editable persona copy, so its backslashes are
doubled: `\&` in a Postgres replacement re-emits the match, i.e. the very name
being redacted. Empty names are excluded (an empty alternative matches everywhere)
and matching is anchored by negative lookaround rather than `\y`, which requires
a word character on the inside edge and would therefore never match a name
beginning with punctuation or an emoji.

**Availability.** Every read of the operator's settings inside the views compares
JSON rather than casting, because `('maybe')::boolean` raises and a raise inside
`published_messages` would take the entire public archive offline. An absent
setting takes the shipped default; a present but malformed one reads as "off".

**Fail-closed, but never silent (Addendum A).** A missing derivative is regenerated on demand
at serve time and swept at boot; anything still unservable goes to a failure log rather than
disappearing quietly. Self-healing retries the STRIP — it never falls back to the original, so
the guarantee is unchanged. The live fault that prompted this was a permission: the `derived/`
tree had been created by a one-off script running as root, and the service user could not write
into it. Run remediation as the service user.

**Limits, stated plainly.** Under `redact` the row stays published, so a copy
already fetched by a feed reader or a crawler keeps the pre-redaction text, and a
browser tab already showing the card keeps it until reloaded (the live reconcile
adds and removes whole cards, it does not rewrite one in place). `withhold`
removes the row from the feed and from the live stream, and is the stronger choice
where that matters.

## 9c. Plugin secrets — stored once, never twice (CCB-S3-008)

Provider API keys are encrypted at rest with a key derived from `SESSION_SECRET`, are never
rendered back into the form, and never reach a log or an audit entry. CCB-S3-008 fixed a defect
in that machinery worth recording, because it failed in the safe direction and was therefore
invisible.

The admin form and the stored settings shared one field name, so loading the stored settings was
indistinguishable from submitting the form, and each boot encrypted the stored key again. The
runtime decrypts exactly once, so providers were sent `v1.<iv>.<tag>.<ct>` as their API key. No
secret leaked — the failure mode was a credential that could not work — but every authenticated
provider call had been failing since the feature shipped, reported to the operator only as "the
markets are out of earshot".

The fix is structural: a submitted key arrives as `apiKeyInput` and a stored one as `apiKey`,
so the two can no longer be confused. `applySecretUpdate` also refuses to encrypt a value that
already looks like an envelope, and existing doubled values are unwrapped and rewritten once at
load, with a count logged and the value never named.

## 9d. Media metadata, and what the public path actually serves (CCB-S3-011 §1)

A member consenting to publish their words is not consenting to publish the coordinates of the
room they were standing in. Consent covers the content; EXIF is a hidden payload nobody agreed
to.

**Published media is served from a stripped DERIVATIVE, never the original.** `sharp` re-encodes
without metadata, which drops EXIF, IPTC and XMP together. Orientation is baked into the pixels
first (`.rotate()`), because a privacy control that visibly rotates every photo gets switched
off, and then nothing is stripped at all. The original stays byte-for-byte on disk for the
operator, for moderation, and for any preserve-and-report obligation.

**The gate fails closed.** `getPublishedMedia` serves a strippable format ONLY from its
derivative. A missing derivative means stripping has not happened, and the safe reading of that
is "not publishable" — never "serve the original". Turning the admin switch off therefore
withholds new media rather than publishing it unstripped.

**What this instance cannot strip.** Video and documents need ffmpeg, which is not installed.
Those formats are recorded as unstrippable rather than assumed clean, and the admin help text
says so. They are still served, because the audit below found no metadata in them — but that is
a measured fact, not a guarantee.

**The filename leak was checked and did not exist.** Public media URLs have always been
`/embed/<instance>/media/<message-id>` — opaque, no filename, no path — and the sitemap, feed and
JSON-LD all build the same form; `content-disposition` carries no filename and the download
attribute is synthesised. Verified before changing anything. Derived files are named by message
id for the same reason, so nothing of the member's own filename exists in the derived tree
either. A harness check asserts both directions: an opaque URL passes, a URL carrying a filename
fails.

**The audit.** All 57 captured files (47 images, 8 videos, 2 documents) were scanned with a
purpose-built detector, validated in both directions against a hand-built GPS fixture. None
carried EXIF, IPTC, XMP or MP4 metadata atoms — the SimpleX client re-encodes images before
sending. That is an accidental property of a third-party client, not a guarantee Cinderella
makes, which is exactly why the stripping exists.

## 9e. Member instructions are member content (CCB-S3-009)

Messages consumed as instructions are now archived and publish on the ordinary consent rules.
Two properties keep that safe.

**Consent still decides.** An instruction from somebody who never opted in is not published, the
same as any other message of theirs. Nothing about being addressed to a bot widens the gate.

**An answer cannot outlive its question.** A reply publishes only if the message it answers
does, derived on every read. So a non-consenting member's question stays private AND her answer
to it is withheld — which matters because an answer often paraphrases the question. This
composes with the CCB-S3-007 leak guard rather than replacing it: the guard handles names inside
her text, this handles the exchange as a unit.

The consent mechanics themselves — `/publish`, bare `yes` confirmations, disambiguation answers —
are captured but excluded by default, so the operator's switch has something real behind it
rather than the messages being dropped at the door.

## 9f. Undo may only reduce exposure (CCB-S3-010 Addendum A)

Undo exists so a member can take back a mistake. It must never be able to take back a
*protection*.

`undoLastConsentAction` used to restore the exact prior consent state, which meant undoing a
revocation cleared `revoked_at` and returned everything to public view for the length of the
undo window. The rule is now explicit and lives in one predicate: an action is undoable only if
undoing it REDUCES exposure. Opt-in qualifies; revocation does not.

No path can now return revoked content to public view. Re-opting in is forward-only and restores
nothing from before, and the refused undo leaves `revoked_at` untouched — both asserted in
`verify:consent`.

## 9g. Video-link cards — click-to-play, no third party before the click (CCB-S3-014)

A YouTube link renders as a play card, but a normal embed loads Google's player and trackers on
page load — the third-party loading the product exists not to do, and the kind that needs prior
consent under EU rules. So the card is CLICK-TO-PLAY: the click is the consent.

**Nothing third-party loads before the click.** The thumbnail is fetched once at capture (from the
wire preview SimpleX already delivered, else a one-time server fetch) and served from our own
`/media` path — metadata-stripped and consent-gated like any image. The player iframe is written by
a first-party click handler, never on load, scroll or hover, and points at `youtube-nocookie.com`.
An "open on YouTube" link lets a visitor leave instead. Verified in a browser: a fresh page load
makes zero requests to Google/ytimg; the nocookie request appears only after the click.

**The embed-page CSP, in full** (the admin console CSP is unchanged):

```
default-src 'none';
img-src 'self';
media-src 'self';
frame-src https://www.youtube-nocookie.com;   ← only on a page that has a video card; 'none' otherwise
style-src 'nonce-…';
script-src 'nonce-…';                          ← no third-party script allowance, ever
frame-ancestors *;
base-uri 'none';
form-action 'self';
connect-src 'self'
```

`frame-src` is the ONLY widening, added only where a card exists. `img-src` stays `'self'` — if a
thumbnail were served from a CDN it would need a third-party img-src, and that absence is the proof
it is local. `script-src` gains nothing: the player runs in its own iframe context.

## 9h. Private support-scope messages are never captured (CCB-S3-019)

A group member can open a private "Chat with admins" thread — a **member-support scope**. The
SimpleX core delivers those items on the **same `newChatItems` event** as ordinary group messages,
distinguished only by `ChatInfo.Group.groupChatScope` (present = private; absent = public;
types.d.ts:978). The CCB-S3-016 audit flagged that the capture pipeline had no check for this: if a
member who had opted in used that thread, their private conversation would have been captured and
published — the one guarantee a private channel exists to give, and unrecoverable once read
(revocation cannot unpublish what people have already seen).

**The gate is a whitelist, not a blacklist.** `isPublicGroupChat(chatInfo)` in
`src/capture/message.ts` returns true only when the item is POSITIVELY a public group chat —
`type === 'group'` **and** `groupChatScope === undefined`. Everything else is excluded: a direct
chat (which also satisfies CCB-S3-017 §2's direct-message exclusion), a support-scope item, and — by
construction — any future scope this predicate does not recognise as public. **Fail closed:** a
missing archive row is recoverable; a leaked private message is not.

**It sits at the single unavoidable point.** `parseGroupMessage` is the one function every incoming
item passes through (the `newChatItems` capture path and `chatItemUpdated` edits), and it calls the
gate before persistence, before consent evaluation, before anything. The in-group deletion handler
uses the same predicate. A new message type or plugin cannot route around it without going through
`parseGroupMessage`, and the harness fails if it tries.

**Enforcement is proven, not asserted.** `verify:support-scope` drives the real migrations, the real
handler and the real publication view against PGlite: a support-scope item (from an opted-in member,
so consent is not what excludes it) never reaches persistence, never lands in `messages`, and never
appears in `published_messages`, while an ordinary message does. Removing the gate makes six of its
checks fail. `scripts/scan-support-scope.ts` inspects stored `raw_json` for the discriminator to
find (and `--remove` to delete) any item captured before the gate existed — reporting counts and
ids, never the private content.

**An excluded item is not always silent.** Direct chats and the `memberSupport` scope are EXPECTED
exclusions and pass without a sound. But if a group item carries a scope we do not recognise — a new
SimpleX scope, or a malformed item — capture is stopping for a reason we cannot explain, and dropping
it in silence is the failure mode this project keeps closing. So `unrecognisedScopeType` distinguishes
the two: only the unrecognised case is counted (`src/capture/scope-diagnostics.ts`, in-memory, per
process) and surfaced on the dashboard as an **amber** notice — worth understanding, not a red
consent leak. `verify:support-scope` proves the counter moves for an unknown/malformed scope and
stays still for the expected ones. This was CCB-S3-019's remediation finding in practice: the scan
found **2 support-scope rows already captured, 0 ever published**, from one member; both were removed.

## 10. Public archive front — a separate, consent-gated public surface (CCB-S2-003)

The `/embed/<id>` front is the one deliberately public surface. Its security rests on
keeping it strictly separate from the authenticated admin and gating everything on
consent:

- **Consent gate in SQL, re-checked per request.** Every public read goes through the
  `published_messages` view (`src/db/public-archive.ts`). The public media route
  `GET /embed/:id/media/:msgId` calls `getPublishedMedia` on **every** request and
  serves only for a currently-published item — an unpublished / re-unpublished /
  deleted item's media returns `404`. Media is never served by a client-supplied raw
  path; the DB-stored path is additionally resolved within `MEDIA_ROOT` with a
  traversal guard (`src/web/front/embed.ts`).
- **Distinct from the admin media path.** The admin `/media/**` static mount stays
  behind the auth guard (§6). The public path is a different route with its own
  consent check — the admin path is not reused.
- **Isolation in the request pipeline.** `/embed/*` is exempt from the admin auth
  guard, the admin IP allow/deny policy, and the admin rate-limit (a public surface
  must reach everyone), and the admin strict headers (`x-frame-options: DENY`,
  `noindex`, `no-store`) are **skipped** for it in the onSend hook
  (`src/web/server.ts`).
- **Embed response headers.** The front sets its own: a CSP of
  `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'nonce-…';
script-src 'nonce-…'; frame-ancestors *; base-uri 'none'; form-action 'self';
connect-src 'self'` (embeddable anywhere, no external assets; `media-src 'self'`
  admits only the front's own consent-gated inline `<video>`/`<audio>`, CCB-S2-008),
  `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, and `cache-control: no-store` (consent freshness —
  publish/unpublish/delete reflect immediately). `connect-src 'self'` is the sole CSP
  allowance for the live-update poll (CCB-S2-006) — same-origin `fetch` only, no
  third party; a configured analytics origin is added on top for that one instance
  (D-017). The inline themed `<style>` and the nonce'd `<script>`s (height, theme
  toggle, and the live-update client) carry the per-response nonce; there is no
  `'unsafe-inline'`.
- **Indexable by design.** The public front is `index, follow` (the SEO goal); the
  admin console remains `noindex, nofollow` — unchanged. nginx sets
  `X-Robots-Tag: noindex, nofollow` at the server level (to keep the admin out of
  search); a dedicated `location /embed/` block overrides it with `index, follow`
  (and re-adds HSTS, since `add_header` in a location replaces inherited ones) —
  see [`deploy/nginx-admin.conf`](../deploy/nginx-admin.conf). Without this, the
  edge header would defeat the page's `<meta robots>`.
- **Live auto-update + infinite scroll inherit the gate (CCB-S2-006/007).** The
  visitor-driven endpoints `GET /embed/:id/state?cursor=&top=` (band ids + a version
  hash + `hasNewer`) and `GET /embed/:id/page?cursor=&dir=` (a chunk of rendered cards)
  read the SAME `published_messages` view, so neither can emit an unpublished / recalled
  id. The cursor is a SORT KEY, never a security boundary: a malformed cursor is a `400`
  (never a silent page-1), and a valid-but-arbitrary cursor only selects a published
  sort position — so no HMAC is needed. When an item is withdrawn its id leaves the band
  (hash changes → the client removes that card wherever it sits) and its media `404`s,
  within one poll interval; windowed-out cards are DISCARDED (never stashed) and
  scroll-up re-fetches through the gate, so a card recalled while off-screen can't
  return. `state` carries ids + hash only (short-TTL `max-age=5`, at most a TTL's delay,
  never a leak); `page` is `no-store`. `/state` and `/page` have SEPARATE per-IP
  rate-limit buckets (`POLL_RATE_PER_MIN` / `PAGE_RATE_PER_MIN`) so a scroll burst can't
  429 the consent-critical poll. The CCB-S2-006 `/fragment` route + wholesale swap are
  removed.
- **Inline video inherits the gate (CCB-S2-008).** Video plays inline via `<video>`
  loading from the SAME consent-gated media route; the route now answers HTTP `Range`
  with `206`/`Accept-Ranges` (WebKit needs it to play; seeking needs it), but the range
  branch runs **strictly after** `getPublishedMedia` + the path-containment guard, so a
  recalled/unpublished id still `404`s whether or not a `Range` header is present
  (`verify:public` asserts unpublished + Range → 404). The per-instance download button
  (`player.showDownload`, default ON) is a UI affordance, not an access control: a
  published item's bytes are inherently fetchable at its URL, and `controlsList=nodownload`
  is a cosmetic, Chromium-only hint — the real gate remains publication state. The embed
  snippet's iframe carries only `allow="fullscreen"` (allowlist defaults to its own
  origin), the minimum needed for the native fullscreen button; no wider delegation.
- **Content reporting is minimal-data + non-hiding (CCB-S2-009).** `POST /embed/:id/report`
  is the ONE mutating public-front route. It is exempt from the admin CSRF/step-up preHandler
  (a public surface with no session/cookie to defend — the exemption is scoped to
  `isPublicFront`, verified by a matcher-boundary test); its defences are: an own strict per-IP
  rate limit (checked before any DB work), a `Sec-Fetch-Site` cross-site rejection (anti-flood
  — the report form is always served from the archive origin, so a legit submit is same-origin
  even inside a third-party iframe), reason-enum validation, and a note cap. It gates on
  `isPublished` (`published_messages`) and returns the SAME neutral 303 for unpublished /
  recalled / nonexistent ids, storing nothing — no existence/publication oracle, and a report
  can never attach to non-public content. A report writes ONLY the `reports` table and NEVER
  changes publication (visible-until-review — it cannot be weaponised to hide content). Stored
  data is minimal: the only reporter-derived value is a keyed, non-reversible
  `HMAC(sessionSecret, ip|msgId|utc-date)` — no raw IP, UA, cookie, or fingerprint — that
  rotates daily and is per-item, so it profiles no one and self-expires; dedup is a unique
  constraint. The note is stored raw and **escaped on admin render** (`html\`\``, never `raw()`),
  the reason is enum-validated, so neither can XSS the queue. No data leaves the system (the
  external-alert channels are an inert, disabled Settings placeholder). The admin queue + audited
  actions sit behind the existing auth guard.
- **Flagged follow-up.** SSR/media caching with invalidation on publish events is
  deferred (the page still renders per request); an SSE transport for live-update is a
  recorded future upgrade over today's polling.
- **SEO artifacts inherit the gate (CCB-S2-004).** The sitemap, RSS feed, JSON-LD
  structured data, and OG preview are all built in `src/web/front/seo.ts` from the
  same consent-gated data — no unpublished content is ever referenced or emitted
  (feed items come from `published_messages`; the sitemap lists only public front
  URLs; `verify:public` asserts no unpublished text appears in any of them). Every
  operator-supplied URL (canonical base, OG image, org/logo, analytics) is validated
  as **https-only** in `normalizeSeo` so a stored/posted value can't inject
  `javascript:`; the JSON-LD escapes `<` so message text can't break out of the
  script block; XML outputs are entity-escaped.
- **Analytics (D-017).** Off by default and per-instance. A configured analytics
  script origin is added to `script-src`/`connect-src` for **that instance's public
  page only** (`applyEmbedHeaders`) — never the admin CSP, never globally, and the
  admin form states this. (Since CCB-S2-012, `robots.txt` is `Allow: /` with explicit
  admin-surface disallows — see §11 — and the sitemap index also lists the marketing
  site's sitemap.)

## 11. Public marketing site — indexable, non-embeddable, consent-gated add-ons (CCB-S2-012)

The domain root `/` serves a public SSR marketing site ([`src/web/site/`](../src/web/site/)),
a THIRD public surface alongside the archive front and the (private) admin. Its security
posture:

- **Its own headers (`applySiteHeaders`, [`src/web/site/routes.ts`](../src/web/site/routes.ts)).**
  The same strict, self-contained nonce CSP as the archive front —
  `default-src 'none'; img-src 'self' data:; style-src 'nonce-…'; script-src 'nonce-…';
connect-src 'self'; base-uri 'none'; form-action 'self'` — but **non-embeddable**:
  `frame-ancestors 'none'` **plus** `X-Frame-Options: DENY` (the archive front is the
  opposite, `frame-ancestors *`, because it must embed). Also `nosniff`,
  `referrer-policy: no-referrer`, `cache-control: no-store` (each page carries a
  per-request nonce, so it is inherently uncacheable). No inline event handlers or inline
  `style=` attributes — everything runs under the nonce.
- **Indexable; the admin is not.** The site emits `robots: index, follow` (thin "coming
  soon" stubs are `noindex, follow`); the admin shell stays hardcoded `noindex, nofollow`.
  The admin dashboard moved off `/` to `/dashboard`; the operator login is a discreet link
  to the unchanged, hardened admin. `robots.txt` is now `Allow: /` with explicit
  `Disallow:` for every admin surface (`/login`, `/dashboard`, `/messages`, `/consent`,
  `/settings`, `/security`, `/embeds`, `/website`, `/reports`, `/webauthn/`, `/healthz`).
- **Public-surface exemptions.** `isPublicSitePath` (root, `/<lang>*`, the site sitemap)
  is checked alongside `isPublicFront` in the three server hooks, so the site is exempt
  from the admin auth guard, CSRF, IP allow/deny, and the admin rate limit (it has no
  mutating routes and no session). The admin config page `/website` is NOT public — it
  stays behind auth.
- **Consent-gated analytics (D-025).** The three building blocks default OFF and are
  admin-configurable ([`src/site/settings.ts`](../src/site/settings.ts), audited under
  `site.update`). Analytics loads **nothing** until the visitor accepts the cookie banner:
  the operator's HTTPS snippet URL is injected client-side only on `cin-consent=granted`,
  and the analytics origin is added to the site CSP `script-src`/`connect-src` only when
  `shouldLoadAnalytics` (analytics on **and** a URL **and** the banner on) — so with the
  banner off there is no tracking at all. Operator input is https-validated
  (`normalizeSite`), and in the inline bootstrap the URL is JSON-escaped with its
  less-than characters unicode-escaped, so a hostile value can't break out of the
  script tag (`verify:site` asserts this). Social share
  is script-free anchors (no vendor widget, no third-party origin). Essential storage —
  the theme (`sg-theme`) and the language cookie (`cin-lang`, HttpOnly, SameSite=Lax) —
  needs no consent. Verified by [`scripts/verify-site.ts`](../scripts/verify-site.ts).
