---
sidebar_position: 2
title: OAuth Credentials
---

# OAuth Credentials

CodeRunner does not store passwords. Sign-in is handled by
[Better Auth](https://www.better-auth.com/) using GitHub, Google, and/or a
generic OIDC provider such as Authentik as OAuth providers. **At least one
provider must be configured** for any non-demo deployment; without one, the
login page has no working sign-in button.

You only need one; configure more if you want students to choose between
sign-in options, or if your team already runs Authentik (or another OIDC
provider) as its identity provider and you'd rather point CodeRunner at it
than register a separate GitHub/Google app.

This page covers registering the OAuth apps and wiring the resulting
credentials into CodeRunner. The values you produce here are used the same way
whether you deploy [locally](./local.md) or to [Google Cloud](./gcloud.md);
only the URLs differ (`http://localhost:4000` vs `https://<your-domain>`).

## The two URLs you will need

Every OAuth app registration asks for a homepage/origin URL and a redirect
(callback) URL. For CodeRunner:

- **Homepage / origin** = your `BETTER_AUTH_URL` (the public base URL of the
  app).
- **Callback / redirect URL** = `BETTER_AUTH_URL` + a fixed per-provider path.
  Better Auth mounts its routes at `/api/auth` (confirmed in
  `apps/control/src/auth/auth.ts`), so the callbacks are:

  | Provider | Callback URL |
  | --- | --- |
  | GitHub | `<BETTER_AUTH_URL>/api/auth/callback/github` |
  | Google | `<BETTER_AUTH_URL>/api/auth/callback/google` |
  | Authentik (generic OIDC) | `<BETTER_AUTH_URL>/api/auth/oauth2/callback/authentik` |

For local development that is `http://localhost:4000/api/auth/callback/github`
and `.../google`. For the cloud VM it is
`https://<your-domain>/api/auth/callback/github` and `.../google`. Note the
Authentik callback path is `/oauth2/callback/authentik`, not `/callback/authentik`
— it's handled by Better Auth's `genericOAuth` plugin rather than a built-in
social provider.

## Register a GitHub OAuth app

In GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

- **Application name:** anything (e.g. "CodeRunner - Team 1234").
- **Homepage URL:** your `BETTER_AUTH_URL`.
- **Authorization callback URL:** `<BETTER_AUTH_URL>/api/auth/callback/github`.

Save, then generate a client secret. You now have a **Client ID** and a
**Client Secret**.

## Register a Google OAuth client

In the Google Cloud console:

1. **APIs & Services → OAuth consent screen**: configure it once (External
   user type is fine for a team). Add your sign-in email as a test user while
   the app is in testing.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
   - **Authorized JavaScript origins:** your `BETTER_AUTH_URL`.
   - **Authorized redirect URIs:** `<BETTER_AUTH_URL>/api/auth/callback/google`.

You now have a **Client ID** and a **Client Secret**.

## Register an Authentik OAuth2/OpenID provider

In Authentik: **Applications → Providers → Create**, type **OAuth2/OpenID
Provider**.

- **Client type:** Confidential.
- **Redirect URIs:** `<BETTER_AUTH_URL>/api/auth/oauth2/callback/authentik`.
- **Scopes:** include at least `openid`, `email`, and `profile`.

Then **Applications → Applications → Create** and bind it to the provider you
just made (e.g. slug `coderunner`). Authentik's OIDC discovery document for
that application lives at
`https://<your-authentik-domain>/application/o/<app-slug>/.well-known/openid-configuration`
— CodeRunner uses this to discover the authorization/token/userinfo endpoints
automatically, so you only need the base issuer URL
(`https://<your-authentik-domain>/application/o/<app-slug>/`), not each
endpoint individually.

You now have a **Client ID**, a **Client Secret**, and an **issuer URL**.

## Wire the credentials into CodeRunner

CodeRunner reads these from environment variables (see
`apps/control/src/config.ts` and [Configuration](../reference/configuration.md)):

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_URL` | Public base URL. **Must match** the homepage/callback URLs you registered. Defaults to `http://localhost:4000`. |
| `BETTER_AUTH_SECRET` | Secret used to sign sessions. **Change this in production**; the built-in default is a dev placeholder. Generate one with `openssl rand -hex 32`. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `AUTHENTIK_CLIENT_ID` | Authentik OAuth2/OpenID provider client ID |
| `AUTHENTIK_CLIENT_SECRET` | Authentik OAuth2/OpenID provider client secret |
| `AUTHENTIK_ISSUER_URL` | Authentik application issuer, e.g. `https://authentik.example.com/application/o/coderunner/` |

GitHub/Google only appear on the login page when **both** their ID and secret
are set; Authentik requires all three of its variables. Where these values
live depends on the deployment:

- **Local:** in your `.env` file. See [Local Deployment](./local.md).
- **Cloud VM:** in Google Secret Manager, materialized into the VM's `.env` by
  `render-env.sh` at boot. See [Google Cloud Deployment](./gcloud.md).

## Bootstrapping the first admin

OAuth establishes *who* a person is; CodeRunner separately controls *whether*
they may sign in (the allowlist) and *whether* they are an admin (the role).

### The easy path: `CODERUNNER_ADMIN_EMAIL`

Set `CODERUNNER_ADMIN_EMAIL` (comma-separated for multiple people) alongside
your OAuth credentials before the first startup and the two steps below happen
automatically — **no exec commands needed**. At startup the control plane adds
each listed email to the allowlist, and on first OAuth sign-in the account is
created with the admin role. An account that already exists with that email is
promoted to admin at the next startup, so it also rescues a coach who signed in
before the env var was set.

```bash
CODERUNNER_ADMIN_EMAIL=coach@frcteam.org,assistant@frcteam.org
```

This is the recommended way to reach the admin panel on a fresh deployment. The
manual commands below are still useful for allowlisting students and for
changing roles later.

### Manual bootstrap and later changes

:::note[Running these commands]

On a containerized deployment (the default) the `allowlist` and `users`
commands run **inside the control container** via the `coderunner` CLI:

```bash
docker compose exec control coderunner allowlist add coach@frcteam.org
docker compose exec control coderunner users promote coach@frcteam.org
```

Use `docker compose run --rm control <subcommand>` instead while the control
plane is stopped. On the Google Cloud VM the compose project lives in
`/opt/coderunner` and needs `sudo` (`cd /opt/coderunner && sudo docker compose
exec -T control …`). The `bun run …` short forms shown below are equivalent
and apply to a from-source host checkout with Bun.

:::

### 1. Allowlist the emails that may sign in

The allowlist gates every OAuth login. Until an email or domain is added,
sign-in is blocked for everyone. Add an individual email or a whole domain:

```bash
bun run allowlist:add coach@frcteam.org
# or allow an entire domain:
bun run allowlist:add frcteam.org
```

Other allowlist commands: `bun run allowlist:list`, `bun run allowlist:remove`.

### 2. Promote the first admin

Every user, including the first one, signs in as a regular user. After the
first coach has signed in once (so their user row exists), promote them to
admin:

```bash
bun run users:promote coach@frcteam.org
```

The reverse is `bun run users:demote`, and `bun run users:list` shows current
roles. On the cloud VM, run `coderunner users promote` over IAP SSH; see the
[Google Cloud Deployment](./gcloud.md) "Become the first admin" step.

> Admins also get a break-glass option: setting the `ADMIN_TOKEN` env var lets
> you call the `/admin/*` API with a bearer token even before any user is
> promoted. See [Configuration](../reference/configuration.md).
