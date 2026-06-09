---
title: API Reference
description: OpenAPI specifications for Oblivion consumer and partner integrations.
---

# API Reference

Machine-readable OpenAPI specs live outside the docs reader so guides stay uncluttered. Use the links below to download YAML or open an external explorer in a new tab.

> **Beta software** — Oblivion is experimental. API shapes may change; integrate at your own risk.

## Resources

- [Consumer API](/docs/developers/consumer-api) — case access tokens, `/api/*` auth
- [Partner API guide](/docs/developers/partner-api) — auth, cases, webhooks, billing
- [Partner onboarding](/docs/developers/partner-onboarding) — 30-minute design-partner checklist

## Download specs

| Spec | YAML |
|------|------|
| Partner API (`/v1/*`) | [`openapi-v1.yaml`](/openapi-v1.yaml) |
| Consumer API (`/api/*`) | [`openapi-consumer.yaml`](/openapi-consumer.yaml) |

The hosted app also mirrors partner YAML at `/docs/openapi-v1.yaml` for local demos.

## Open in external explorer

These open **Swagger Editor** in a new tab with the hosted spec URL:

- [Partner API — open in Swagger Editor](https://editor.swagger.io/?url=https://oblivion-docs.pages.dev/openapi-v1.yaml)
- [Consumer API — open in Swagger Editor](https://editor.swagger.io/?url=https://oblivion-docs.pages.dev/openapi-consumer.yaml)

## Base URLs

**Consumer** routes use `/api/*` on your deployment (browser app default).

**Partner** routes use `/v1/*` with a partner API key:

```sh
curl -sS -H "Authorization: Bearer obl_live_..." \
  http://localhost:8080/v1/partners/me
```