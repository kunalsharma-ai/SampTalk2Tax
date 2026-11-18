# Two-step sign-in (SEC-005)

A person can ask Talk2Tax for a second check after their password: a 6-digit code from an
authenticator app on their phone (Google Authenticator, Microsoft Authenticator, 1Password,
Authy or any app that supports time-based codes). Someone who learns the password still
cannot sign in.

## How it works

* **Codes.** Time-based one-time passwords (RFC 6238): HMAC-SHA-1 over a 160-bit secret,
  6 digits, 30-second steps, which is what every app supports when it scans a QR code. One
  step either side is accepted for clock drift. Each step's code is accepted once: the last
  used step is stored and an older or equal one is refused, so a code seen over someone's
  shoulder cannot be replayed. `packages/security/src/totp.ts`, tested against the RFC 4226
  and RFC 6238 vectors.
* **The secret** is sealed with AES-256-GCM (`SecretBox`, the same key as integration
  secrets: `INTEGRATIONS_ENCRYPTION_KEY`, or one derived from `JWT_SECRET`). If the server key
  changes, codes cannot be checked and the person is told to use a recovery code and set it
  up again.
* **Recovery codes.** Ten single-use codes like `7KQ4-M2XD-9FHA`, shown once when it is
  turned on. Only SHA-256 hashes are kept. Case, spaces and dashes do not matter. New codes
  replace all the old ones, and getting new ones needs a code from the app (not a recovery
  code).

## Turning it on and off

On **Account and preferences → Two-step sign-in**:

1. Turn on, enter the password (whoever holds the secret can make codes).
2. Scan the QR code (an `otpauth://` URI) or type the key, then type the code the app shows.
   Until then it is pending and the password alone still signs in.
3. Save the recovery codes (copy or download as text).

Turning it off needs the password and a code from the app or a recovery code.

## Signing in

`POST /v1/auth/login` with the right password answers `{ mfaRequired: true, challengeToken,
expiresIn: 300 }` instead of tokens. The client sends `POST /v1/auth/login/code` with the
challenge and a code from the app or a recovery code, and gets the usual session. The
challenge lasts five minutes and five wrong codes end it (the person signs in again with the
password, which the sign-in lockout still counts). A wrong password answers exactly as
before, so it does not reveal whether two-step sign-in is on.

The web app keeps the challenge in an httpOnly, SameSite=Strict cookie (`t2t_mfa`) limited to
the `/api/session` path, so page scripts never see it.

## Data (MongoDB)

| Collection | What it holds |
| --- | --- |
| `user_mfa` (global, id = user id) | status PENDING or ACTIVE, sealed secret and key id, last used step, recovery code hashes with when each was used, when it was turned on. Guards: starts pending; active records when it was turned on; an active secret cannot be swapped in place; a used step cannot be made usable again. |
| `mfa_challenges` (global) | sign-ins waiting for a code: user, hash of the challenge secret, wrong attempts (at most 5), expiry, when used, address and browser. A TTL index removes expired ones. Guards: cannot be changed or reused, attempts only go up. |

## Audit trail

`user.mfa_enabled`, `user.mfa_disabled`, `user.mfa_recovery_codes_replaced`,
`user.mfa_recovery_code_used`, `user.mfa_challenge_failed` (five wrong codes), and
`session.created` records `secondStep: APP | RECOVERY_CODE` for a two-step sign-in.

## Not included

SMS and email codes (weaker, and need a provider), passkeys / WebAuthn, and an organisation
rule that requires two-step sign-in for its members (next slice).
