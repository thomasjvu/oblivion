import { decryptPayload } from "./crypto.js";

function fieldValue($, id) {
  const el = $(`#${id}`);
  if (!el || !("value" in el)) return "";
  const raw = el.dataset.privacyRealValue ?? el.value;
  return String(raw).trim();
}

export function searchLabelsFromForm($) {
  const name = fieldValue($, "simple-name");
  const region = fieldValue($, "simple-region");
  const alias = fieldValue($, "simple-alias");
  if (!name) return undefined;
  return {
    personLabel: name,
    aliases: alias ? [alias] : [],
    regionLabel: region || undefined
  };
}

export async function searchLabelsForDiscover(state, $) {
  const fromForm = searchLabelsFromForm($);
  if (fromForm?.personLabel) return fromForm;

  if (!state.vaultKey || !state.currentCaseId) return undefined;
  const caseRecord = state.cases.find((item) => item.id === state.currentCaseId);
  const encryptedIntake = caseRecord?.encryptedIntake;
  if (!encryptedIntake) return undefined;

  try {
    const payload = await decryptPayload(state.vaultKey, encryptedIntake);
    if (payload.legalName) {
      return {
        personLabel: String(payload.legalName).trim(),
        aliases: Array.isArray(payload.aliases) ? payload.aliases.filter(Boolean) : [],
        regionLabel: payload.cityState ? String(payload.cityState).trim() : undefined
      };
    }
    if (payload.notes) {
      const fromFormRetry = searchLabelsFromForm($);
      if (fromFormRetry?.personLabel) return fromFormRetry;
    }
  } catch {
    return undefined;
  }
  return undefined;
}