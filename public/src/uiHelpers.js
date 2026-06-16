import { bindIcons, iconEl } from "./icons.js";

export function isUserRejectedError(value) {
  if (!value) return false;
  if (value.reason === "user-rejected") return true;
  const code = value.code ?? value.detail?.code;
  if (code === 4001) return true;
  const message = String(value.message || value.shortMessage || value || "");
  return /user rejected the request/i.test(message);
}

export function paymentErrorMessage(error) {
  if (isUserRejectedError(error)) {
    const raw = String(error?.message || error?.shortMessage || "");
    if (/smart account|upgrade/i.test(raw) || error?.reason === "user-rejected") {
      return "Smart Account upgrade cancelled in MetaMask.";
    }
    return "Payment cancelled in MetaMask.";
  }
  return error?.message || error?.shortMessage || String(error?.error || "Something went wrong.");
}

export function pillClass(value) {
  if (value === true || value === "pass" || value === "used" || value === "ready" || value === "executed" || value === "paid") {
    return "pill pass";
  }
  if (value === false || value === "fail" || value === "blocked") return "pill fail";
  return "pill warn";
}

export function chipClass(value) {
  return pillClass(value).replace("pill", "chip");
}

export function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

export function bindUiHelpers(deps) {
  const { $, state, currentCase, personLabelFromIntake, expandNameTerms, maskPrivacyText } = deps;

  function inputPrivacyValue(id) {
    const el = document.getElementById(id);
    if (!el || !("value" in el)) return "";
    return el.dataset.privacyRealValue ?? el.value ?? "";
  }

  function collectPrivacyTerms() {
    const scope = currentCase()?.redactedScope;
    const extras = [
      inputPrivacyValue("simple-name"),
      inputPrivacyValue("simple-alias"),
      inputPrivacyValue("simple-region"),
      state.intakeText,
      inputPrivacyValue("agent-intake"),
      inputPrivacyValue("intake")
    ].filter(Boolean);
    const label =
      scope?.personLabel ||
      personLabelFromIntake(state.intakeText || $("#agent-intake")?.value || "") ||
      inputPrivacyValue("simple-name")?.trim();
    return expandNameTerms(label, scope?.aliases || [], [
      scope?.region,
      ...(scope?.approvedIdentifierLabels || []),
      ...extras
    ]);
  }

  function displayPlainText(value) {
    const text = String(value ?? "");
    if (!state.privacyFilterMode) return text;
    return maskPrivacyText(text, collectPrivacyTerms());
  }

  function escapeHtml(value) {
    return displayPlainText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setInlineStatus(el, message, options = {}) {
    if (!el) return;
    const text = message ? (typeof message === "string" ? message : paymentErrorMessage(message)) : "";
    const warning =
      options.variant === "warning" ||
      (options.variant !== "success" && options.variant !== "info" && isUserRejectedError(message || text));
    const classes = [
      options.baseClass || "muted small",
      options.extraClass,
      text && warning ? "status-message warning" : "",
      text && options.variant === "fail" && !warning ? "status-message fail" : ""
    ].filter(Boolean);
    el.className = classes.join(" ");
    el.replaceChildren();
    if (!text) return;
    if (warning) el.appendChild(iconEl("alert", { className: "status-message-icon" }));
    const span = document.createElement("span");
    span.className = "status-message-text";
    span.textContent = text;
    el.appendChild(span);
    bindIcons(el);
  }

  function walletErrorMarkup(message) {
    if (!message) return "";
    const text = paymentErrorMessage({ message });
    const warning = isUserRejectedError(message);
    const icon = warning
      ? '<iconify-icon class="status-message-icon" icon="pixelarticons:alert" aria-hidden="true"></iconify-icon>'
      : "";
    const klass = warning ? "wallet-connect-feedback warning" : "wallet-connect-feedback fail";
    return `<p class="${klass}">${icon}<span class="status-message-text">${escapeHtml(text)}</span></p>`;
  }

  return {
    inputPrivacyValue,
    collectPrivacyTerms,
    displayPlainText,
    escapeHtml,
    setInlineStatus,
    walletErrorMarkup
  };
}