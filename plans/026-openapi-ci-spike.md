# Plan 026: OpenAPI contract verification in CI (design spike)

## Status: SPIKE — partial (consumer spec drift fixed manually)

## Next steps

1. Canonical `spec/openapi-consumer.yaml` mirrored to `docs/public/`.
2. Handler tests asserting documented status codes (`GET /api/cases` → 401).
3. Optional: add to `npm run verify`.