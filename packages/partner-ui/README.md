# @oblivion/partner-ui

Embeddable vanilla JS widgets for Oblivion partner integrations. Works with `@oblivion/partner-sdk` for API calls.

## Install

```sh
npm install @oblivion/partner-sdk @oblivion/partner-ui @oblivion/vault-sdk
```

## Usage

```html
<link rel="stylesheet" href="node_modules/@oblivion/partner-ui/widgets.css" />
<div id="status"></div>
<div id="approvals"></div>
<script type="module">
  import { OblivionPartnerClient } from "@oblivion/partner-sdk";
  import { OblivionStatusPanel, OblivionApprovalPanel } from "@oblivion/partner-ui";

  const client = new OblivionPartnerClient({
    baseUrl: "https://oblivion.phantasy.bot",
    apiKey: "obl_live_..."
  });

  const status = new OblivionStatusPanel({
    client,
    caseId: "case_123",
    container: "#status"
  });
  await status.refresh();
</script>
```

## Widgets

- `OblivionStatusBadge` — trust/runtime badge from `/v1/trust/runtime`
- `OblivionStatusPanel` — case phase and counters
- `OblivionApprovalPanel` — pending approval UX with approve/execute callbacks

Docs: https://oblivion-docs.phantasy.bot/docs/developers/partner-api