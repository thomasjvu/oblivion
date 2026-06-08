---
title: Partner API Reference
description: OpenAPI specification for Oblivion partner integrations.
---

# Partner API Reference

The Oblivion partner API is documented in the integration guide and formalized in OpenAPI v1.

## Resources

- [Partner API guide](/docs/developers/partner-api) — auth, cases, webhooks, billing
- [Partner onboarding](/docs/developers/partner-onboarding) — 30-minute design-partner checklist
- [Interactive OpenAPI explorer](/docs/developers/openapi) — try endpoints and schemas in the browser
- [OpenAPI v1 YAML](/openapi-v1.yaml) — machine-readable contract

## Base URL

Production partner routes use `/v1/*` on your Oblivion deployment. Local development defaults to `http://localhost:8080`.

```sh
curl -sS -H "Authorization: Bearer obl_live_..." \
  http://localhost:8080/v1/partners/me
```

## Local OpenAPI mirror

The app also serves the same YAML at `/docs/openapi-v1.yaml` for partner demos that run against a local API server.