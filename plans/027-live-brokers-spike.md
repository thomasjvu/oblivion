# Plan 027: Expand live broker automation (design spike)

## Status: SPIKE — not implemented

## Evidence

`brokerCatalog.ts` `teeAutomatable` brokers route through `broker-opt-out-live` when attestation passes.

## Next steps

Per-broker characterization tests in connector harness (see plan 009), then catalog expansion with policy/approval gates unchanged.