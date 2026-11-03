# Integrations set up in the app

Outside services are connected from inside Talk2Tax, by an owner or admin of each organisation, with no server settings and no restart. Open **Governance → Integrations** (`/orgs/:orgId/settings/integrations`).

| Integration | Used by | What you enter |
|---|---|---|
| **AI: Anthropic Claude** | The AI copilot, the collections agent, AI bank reconciliation and the month-end AI review | Your Claude API key (from console.anthropic.com → API keys) and the model: Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, or any other model id |
| **Email: your mail server (SMTP)** | Payment reminders and automation emails | Mail server, security (STARTTLS on 587 or TLS on 465), port, username, password, sender name and address, optional reply-to. Any provider with SMTP works: Google Workspace, Microsoft 365, Zoho Mail, Amazon SES, SendGrid, Brevo and others |

Webhooks are already set per automation, each with its own signing secret (see [`WORKFLOW_AUTOMATIONS.md`](WORKFLOW_AUTOMATIONS.md)). E-invoicing and e-way bills work through files (the app prepares the portal JSON and reads the response back); a direct GSP connection is not built yet and will get its own card on this page.

## Setting one up

1. Fill in the card and press **Save**. Each organisation has its own settings. A company in a group does not share its parent's.
2. Press **Test connection** (AI) or **Send a test email** (email). The test runs for real:
   * **AI** sends one short request to Claude with your key and model.
   * **Email** connects, signs in and sends an email to you.

   The page then shows **Working** or **Failed** with the provider's reason, when it ran and who ran it. Changing anything resets the result to **Not tested**. Saving alone never shows a connection as working.
3. The badge at the top of each card shows what is **in use** now:
   * **your key** or **your mail server**: the organisation's own settings, switched on;
   * **the server's key** or **the server's mail server**: the fallback, described below;
   * **Not set up**: the features say so and nothing is sent anywhere.
4. Untick **Use this key for this organisation** to stop using it without deleting it. **Remove** deletes it.

The AI features still need their own switches. Turning on the copilot or an agent, and setting its monthly token budget, is done in the AI control center ([`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md)).

When the organisation changes its model, existing copilot conversations are closed and new questions start a new conversation, as they did before when the server's model changed.

## Security

* **Who can do it.** Only owners and admins (`org.manage`) can see the page, change settings or run tests. Everyone else sees "Owners and admins only", and the API answers 403.
* **How secrets are stored.** API keys and SMTP passwords are encrypted with AES-256-GCM before they are stored in `org_integrations`, a tenant table with forced row-level security. They are never sent back to the browser. The page shows only the last four characters ("A key ending …WXYZ is stored"). Leaving the field empty on save keeps the stored secret.
* **What the audit trail records.** Creating, changing, testing and removing an integration are audited. The audit trail records whether the secret changed and its last four characters, never the secret itself.
* **The encryption key.** It is `INTEGRATIONS_ENCRYPTION_KEY` if the server sets one (at least 32 characters). Otherwise it is derived from `JWT_SECRET` with HKDF-SHA256 under its own label, so nothing extra has to be configured. Each stored secret records a short id of the key that sealed it. If that key changes, the card says **Enter the key again** and the integration is not used until it is. It does not fail with an unclear error.
* **Mail servers on private networks.** On a public server (`WEBHOOK_ALLOW_PRIVATE_NETWORKS` not `true`):
  * mail servers on private, loopback or link-local addresses are refused;
  * the host name is looked up once, and the connection is made to that address, so a name cannot be re-pointed between the check and the connection;
  * unencrypted SMTP is not offered.

## The server's settings as a fallback

The environment variables still work, but nobody has to set them:

| Variable | Fallback for |
|---|---|
| `ANTHROPIC_API_KEY` (with `COPILOT_MODEL`) | Organisations with no AI key of their own |
| `SMTP_URL`, `EMAIL_FROM` | Organisations with no mail server of their own |
| `ANTHROPIC_BASE_URL` | Where the Claude API is reached, for every key, including organisations' own. Leave unset for Anthropic itself. It is a server setting so a tenant cannot send keys elsewhere |

An organisation's own settings always win over the server's.

## API

All routes are under `v1/orgs/:orgId/integrations` and need `org.manage`.

| Method and path | Purpose |
|---|---|
| `GET /` | Both cards: whether set up, switched on, settings (no secrets), secret hint, last test, what is in use, and whether the server has a fallback |
| `PUT /ai` `{ apiKey?, model, enabled }` | Save the AI integration. `apiKey` is needed the first time, and again if the stored one can no longer be read |
| `PUT /email` `{ host, port, security, username?, password?, fromAddress, fromName?, replyTo?, enabled }` | Save the mail server |
| `POST /ai/test`, `POST /email/test` | Run the test. Returns `{ ok, message, integrations }` |
| `DELETE /ai`, `DELETE /email` | Remove it |

The copilot status (`GET …/copilot/status`) and the AI control center also report `source`: `ORGANISATION`, `SERVER` or `NONE`. The automations catalogue reports `email: { ready, from, source }`.

## Tests

* `apps/api/test/integrations.e2e.test.ts` covers:
  * that only owners and admins have access;
  * encryption at rest, checked by decrypting the stored row, and that the key never appears in responses or the audit trail;
  * a rejected key and a working key, tested through the official SDK against a local Messages API stand-in;
  * that the copilot uses the organisation's key and model while another organisation stays not set up;
  * switching off;
  * a mail server with a refused login and then a real test email, checking the login, sender and reply-to;
  * that automations send through the organisation's server;
  * removal;
  * a secret sealed with another key;
  * the server fallback;
  * the private-network and unencrypted refusals.
* `apps/web/e2e/integrations-flow.test.mjs` does the same set-up in the browser.

## Not built yet

* Integrations other than AI and email: payment gateways, bank feeds, accounting systems, CRMs, Slack and Teams, and GSP connections for e-invoicing and e-way bills.
* OAuth sign-in for Google or Microsoft mail. Use their SMTP with an app password.
* An external secrets manager such as Vault or a cloud KMS.
* Live checks: tested against local stand-ins only, until a real Claude key and a real mail provider are added on this page.
