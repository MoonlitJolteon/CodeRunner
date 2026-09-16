/**
 * OAuth provider configuration for Better Auth.
 *
 * Reads GitHub, Google, and Authentik credentials from ControlConfig.
 * GitHub/Google go into the `socialProviders` object that betterAuth()
 * expects; Authentik is a generic OIDC provider and is instead built into
 * a config entry for the `genericOAuth` plugin.
 */
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { ControlConfig } from "../config";

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

export type OAuthProvider = "github" | "google" | "authentik";

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
 * Builds the `genericOAuth` plugin config array. Empty unless all three
 * Authentik env vars are set. Discovery is used instead of hardcoded
 * endpoints so any Authentik OAuth2/OpenID provider works without
 * additional config.
 */
export function buildGenericOAuthProviders(
	config: ControlConfig,
): GenericOAuthConfig[] {
	if (
		!config.authentikClientId ||
		!config.authentikClientSecret ||
		!config.authentikIssuer
	) {
		return [];
	}

	const issuer = config.authentikIssuer.replace(/\/$/, "");

	return [
		{
			providerId: AUTHENTIK_PROVIDER_ID,
			clientId: config.authentikClientId,
			clientSecret: config.authentikClientSecret,
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			scopes: ["openid", "email", "profile"],
			pkce: true,
			overrideUserInfo: true,
		},
	];
}
