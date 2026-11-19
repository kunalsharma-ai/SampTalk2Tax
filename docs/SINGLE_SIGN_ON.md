# Single sign-on (SEC-006, SEC-007)

An organisation can let its team sign in with its own identity provider instead of a Talk2Tax
password. Talk2Tax is an OpenID Connect relying party, so this works with Microsoft Entra ID,
Google Workspace, Okta, Auth0, Keycloak, JumpCloud and any other OpenID Connect provider. SAML
is not supported; most SAML providers also offer OpenID Connect.

## Setting it up (Settings → Single sign-on)

1. In the identity provider, register Talk2Tax as a web application. Use the **redirect URI**
   shown on the page, which is `<APP_URL>/api/session/sso/callback`. Allow the `openid`, `email`
   and `profile` scopes.
2. In Talk2Tax, enter the provider's **issuer URL**, **client ID** and **client secret**, then
   choose **Connect**. Talk2Tax reads the provider's discovery document
   (`<issuer>/.well-known/openid-configuration`) straight away, and refuses to save if the
   document cannot be read or names a different issuer. The secret is stored encrypted with the
   integrations key and is never shown again. It is covered by key rotation (SEC-013).
3. Add each **email domain** your team uses, then publish the TXT record shown in that domain's
   DNS. The record name is `_talk2tax-verification.<domain>`, and its value is
   `talk2tax-verification=<random value>`. Then choose **Verify**.
   - A domain can be verified for only one organisation.
   - Only emails at the organisation's verified domains are accepted from its provider.
4. Optionally:
   - **New people at verified domains** can join with a chosen role on their first sign-in:
     accountant, approver, viewer or employee. Owners and admins are always invited.
   - **Require it**: members whose email is at a verified domain can no longer sign in with a
     password. Owners still can, so a broken provider never locks the organisation out.

Only owners and admins (`org.manage`) can change these settings. Anyone with `audit.read` can
see them.

## Signing in

The sign-in page links to **Sign in with single sign-on**. The person enters their work email,
and Talk2Tax finds the organisation whose verified domain matches it.

1. The browser goes to the provider with:
   - the authorization code flow, using PKCE (S256);
   - a random `state` and `nonce`;
   - `login_hint`.

   A random value kept in an httpOnly cookie binds the attempt to that browser. Only its
   SHA-256 is stored. The attempt expires after ten minutes and can be used once.
2. The provider sends the browser back to the callback.
3. The API swaps the code for tokens at the provider's token endpoint, using
   `client_secret_basic`, or `client_secret_post` when that is all the provider supports.
4. The API checks the ID token:
   - The signature must match the provider's published keys. RS256, RS384, RS512, PS256, ES256
     and ES384 are accepted. HMAC and `none` are refused.
   - The issuer, audience (and `azp`), expiry, issue time and nonce must be right.
5. The email in the token must be at one of the organisation's verified domains, and must not be
   marked unverified.
6. If the person is a member, they are signed in.
   - If they are not a member, they join with the chosen role, or are refused if joining is off.
   - Platform administrators always sign in with their password and two-step sign-in.

A session from single sign-on is an ordinary Talk2Tax session. It has the same lifetime,
devices, and sign-out as a password session. An organisation's "require two-step sign-in"
setting still applies.

## Audit trail

| Action | When |
| --- | --- |
| `sso.connection_saved`, `sso.connection_removed` | The provider is connected, changed or disconnected. The record says whether the secret changed, never what it is. |
| `sso.domain_added`, `sso.domain_verified`, `sso.domain_removed` | Domains |
| `sso.signed_in` | A sign-in, with the provider's subject id and whether the person joined |
| `sso.member_joined` | Someone joined on their first sign-in |
| `sso.sign_in_refused` | A refused sign-in and the reason: token, domain, not a member, unverified email, cancelled at the provider, etc. |

## Requests to the provider

The issuer is entered by an organisation's admin, so Talk2Tax treats it as untrusted:

- Requests go only to `https://` addresses.
- The host name is resolved, and every address it resolves to is checked against private,
  loopback and link-local ranges. The connection is made to the checked address.
- Redirects are not followed.
- Answers are limited to 256 KB.
- Each request times out after 8 seconds.

`SSO_ALLOW_PRIVATE_NETWORKS=true` lifts the address checks, for local development and tests only.
`SSO_DNS_SERVERS` chooses the DNS servers used for the TXT checks.

## Not built

- SAML 2.0.
- SCIM provisioning. People who leave are not removed automatically: remove them under Team and
  roles, or turn their account off in the provider so they cannot sign in.
- Single logout at the provider.
- More than one provider per organisation.
