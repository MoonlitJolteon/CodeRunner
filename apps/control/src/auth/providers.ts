/**
 * OAuth provider configuration for Better Auth.
 *
 * Reads GitHub, Google, Auth0, and Authentik credentials from ControlConfig.
 * GitHub and Google are Better Auth social providers; Auth0 (decision 044)
 * and Authentik (generic OIDC) go through the genericOAuth plugin.
 */
import { APIError } from "better-auth/api";
import {
	auth0,
	type GenericOAuthConfig,
	genericOAuth,
} from "better-auth/plugins/generic-oauth";
import type { ControlConfig } from "../config";
import { getLogger } from "../logging";

const log = getLogger("auth");

const AUTH0_NO_ROLE_MESSAGE =
	"Your Auth0 account has no CodeRunner role. Ask your coach for access.";

export type SocialProviders = {
	github?: {
		clientId: string;
		clientSecret: string;
		overrideUserInfoOnSignIn: boolean;
	};
	google?: {
		clientId: string;
		clientSecret: string;
		overrideUserInfoOnSignIn: boolean;
	};
};

export const AUTHENTIK_PROVIDER_ID = "authentik";

export type OAuthProvider = "github" | "google" | "auth0" | "authentik";

export function getEnabledAuthProviders(
	config: ControlConfig,
): OAuthProvider[] {
	const providers: OAuthProvider[] = [];

	if (config.githubClientId && config.githubClientSecret) {
		providers.push("github");
	}

	if (config.googleClientId && config.googleClientSecret) {
		providers.push("google");
	}

	if (config.auth0Domain && config.auth0ClientId && config.auth0ClientSecret) {
		providers.push("auth0");
	}
	if (
		config.authentikClientId &&
		config.authentikClientSecret &&
		config.authentikIssuer
	) {
		providers.push("authentik");
	}

	return providers;
}

export function buildSocialProviders(config: ControlConfig): SocialProviders {
	const providers: SocialProviders = {};

	for (const provider of getEnabledAuthProviders(config)) {
		if (provider === "github") {
			providers.github = {
				clientId: config.githubClientId!,
				clientSecret: config.githubClientSecret!,
				overrideUserInfoOnSignIn: true,
			};
		}

		if (provider === "google") {
			providers.google = {
				clientId: config.googleClientId!,
				clientSecret: config.googleClientSecret!,
				overrideUserInfoOnSignIn: true,
			};
		}
	}

	return providers;
}

/**
 * The genericOAuth plugin carrying Auth0 and/or Authentik, or null when
 * neither is configured. One plugin instance holds both: a second instance
 * would register the same /oauth2 endpoints.
 */
export function buildGenericOAuthPlugin(config: ControlConfig) {
	const enabled = getEnabledAuthProviders(config);
	const providers: GenericOAuthConfig[] = [];
	if (enabled.includes("auth0")) {
		providers.push({
			...auth0({
				domain: config.auth0Domain!,
				clientId: config.auth0ClientId!,
				clientSecret: config.auth0ClientSecret!,
			}),
			overrideUserInfo: true,
			// Runs once per callback with the claims of the identity signing in,
			// before Better Auth creates, links, or updates anything. No role
			// means denied here; otherwise the role is written on every sign-in
			// so the user row (and the session cookie cache built from it)
			// carries the current Auth0 role.
			// `role` is our additional field; the type only lists core fields.
			mapProfileToUser: (profile) => {
				const role = resolveAuth0Role(profile, profile.email ?? "", config);
				if (!role) {
					log.warn("auth0 sign-in rejected: no role", {
						email: profile.email,
					});
					const error = AUTH0_NO_ROLE_MESSAGE.replaceAll(" ", "_");
					// What ctx.redirect throws; the profile mapper has no ctx.
					throw new APIError("FOUND", undefined, {
						location: `/login?error=${encodeURIComponent(error)}`,
					});
				}
				return { role } as Record<string, unknown>;
			},
		});
	}
	if (enabled.includes("authentik")) {
		providers.push(buildAuthentikProvider(config));
	}
	return providers.length ? genericOAuth({ config: providers }) : null;
}

/**
 * Authentik as a generic OIDC provider. Discovery is used instead of
 * hardcoded endpoints so any Authentik OAuth2/OpenID provider works without
 * additional config. Authentik users go through the allowlist like
 * GitHub/Google users.
 */
function buildAuthentikProvider(config: ControlConfig): GenericOAuthConfig {
	const issuer = config.authentikIssuer!.replace(/\/$/, "");
	return {
		providerId: AUTHENTIK_PROVIDER_ID,
		clientId: config.authentikClientId!,
		clientSecret: config.authentikClientSecret!,
		issuer,
		discoveryUrl: `${issuer}/.well-known/openid-configuration`,
		scopes: ["openid", "email", "profile"],
		pkce: true,
		overrideUserInfo: true,
	};
}

/**
 * Map an Auth0 user's ID-token claims to a CodeRunner role. Admin emails
 * (CODERUNNER_ADMIN_EMAIL) are admin once Auth0 has verified the address;
 * otherwise the roles claim must hold the configured admin or user role
 * name. Null means "no access".
 */
export function resolveAuth0Role(
	claims: Record<string, unknown>,
	email: string,
	config: ControlConfig,
): "admin" | "student" | null {
	// An unverified address proves nothing: anyone can register it in a
	// tenant that allows sign-up.
	if (
		claims.email_verified === true &&
		config.adminEmails.includes(email.toLowerCase())
	) {
		return "admin";
	}
	const raw = claims[config.auth0RolesClaim];
	const roles = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	if (roles.includes(config.auth0AdminRoleName)) {
		return "admin";
	}
	if (roles.includes(config.auth0UserRoleName)) {
		return "student";
	}
	return null;
}
