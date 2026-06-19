export const INFISICAL_CONFIG = {
  domain: "https://infisical.phantasy.bot",
  organizationId: "3f80ae72-bc03-474a-8b14-108b3bb2dbf4",
  projectId: "baa5ece8-bf19-441b-96f9-5d3f6affd104",
  secretPath: "/",
  secretType: "shared",
  environments: {
    dev: {
      name: "dev",
      workingFile: ".env",
      infisicalBackupFile: "tmp/secrets/oblivion.dev.env",
    },
    prod: {
      name: "prod",
      workingFile: ".env.production",
      infisicalBackupFile: "tmp/secrets/oblivion.prod.env",
    },
  },
};

/** Keys synced to Infisical — API credentials and deploy-specific URLs only. */
export const DEV_SYNC_KEYS = [
  "BRAVE_SEARCH_API_KEY",
  "VENICE_API_KEY",
  "ONESHOT_API_KEY",
  "X402_PAY_TO",
  "OBLIVION_PUBLIC_API_URL",
  "OBLIVION_CORS_ORIGIN",
];

export const PROD_SYNC_KEYS = [
  ...DEV_SYNC_KEYS,
  "HIBP_API_KEY",
  "X402_CDP_API_KEY_ID",
  "X402_CDP_API_KEY_SECRET",
  "PHALA_ATTESTATION_URL",
  "RESEND_API_KEY",
  "SMTP_PASS",
  "OBLIVION_PARTNER_ADMIN_TOKEN",
  "ONESHOT_AUTHORIZATION",
  "OBLIVION_PARTNER_KEYS",
  "OBLIVION_PARTNER_SANDBOX_KEYS",
];

export function syncKeysForEnv(envName) {
  return envName === "prod" ? PROD_SYNC_KEYS : DEV_SYNC_KEYS;
}

export const INFISICAL_AUTH_ENV = [
  {
    name: "INFISICAL_ACCESS_TOKEN",
    required: "optional",
    description: "Direct bearer token for Infisical API access.",
  },
  {
    name: "INFISICAL_MACHINE_CLIENT_ID",
    required: "conditional",
    description: "Machine identity client ID when not using INFISICAL_ACCESS_TOKEN.",
  },
  {
    name: "INFISICAL_MACHINE_CLIENT_SECRET",
    required: "conditional",
    description: "Machine identity client secret when not using INFISICAL_ACCESS_TOKEN.",
  },
  {
    name: "CF_ACCESS_CLIENT_ID",
    required: "conditional",
    description: "Cloudflare Access client id when the Infisical host is protected.",
  },
  {
    name: "CF_ACCESS_CLIENT_SECRET",
    required: "conditional",
    description: "Cloudflare Access client secret when the Infisical host is protected.",
  },
];

export const PROD_REQUIRED_SECRETS = [
  "BRAVE_SEARCH_API_KEY",
  "VENICE_API_KEY",
  "ONESHOT_API_KEY",
  "X402_PAY_TO",
  "OBLIVION_PUBLIC_API_URL",
  "OBLIVION_CORS_ORIGIN",
];

/** Required for full live connector + mainnet x402 settlement (warn if missing). */
export const PROD_LIVE_SECRETS = [
  "HIBP_API_KEY",
  "X402_CDP_API_KEY_ID",
  "X402_CDP_API_KEY_SECRET",
];

export const PROD_OPTIONAL_SECRETS = [
  "PHALA_ATTESTATION_URL",
  "RESEND_API_KEY",
  "SMTP_PASS",
  "OBLIVION_PARTNER_ADMIN_TOKEN",
  "ONESHOT_AUTHORIZATION",
  "OBLIVION_PARTNER_KEYS",
  "OBLIVION_PARTNER_SANDBOX_KEYS",
];

export const SECRETS_SCRIPT_DESCRIPTIONS = {
  "secrets:pull:dev": "Pull Infisical `dev` secrets into `.env` (managed keys only).",
  "secrets:pull:prod": "Pull Infisical `prod` secrets into `.env.production` (managed keys only).",
  "secrets:push:dev": "Push allowlisted keys from `.env` to Infisical `dev`.",
  "secrets:push:prod": "Push allowlisted keys from `.env.production` to Infisical `prod`.",
  "secrets:backup:dev": "Snapshot Infisical `dev` allowlisted keys to `tmp/secrets/oblivion.dev.env`.",
  "secrets:backup:prod": "Snapshot Infisical `prod` allowlisted keys to `tmp/secrets/oblivion.prod.env`.",
  "secrets:prune:dev": "Delete non-allowlisted keys from Infisical `dev`.",
  "secrets:prune:prod": "Delete non-allowlisted keys from Infisical `prod`.",
  "secrets:doctor": "Check gitignore coverage, Infisical snapshot drift, and required prod keys.",
};