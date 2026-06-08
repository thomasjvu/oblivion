export class OblivionPartnerClient {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...extra
    };
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: this.headers(options.headers),
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const json = await response.json();
    if (!response.ok) {
      const error = new Error(json.error ?? "partner-api-error");
      error.status = response.status;
      error.details = json;
      throw error;
    }
    return json;
  }

  createCase(body) {
    return this.request("/v1/cases", { method: "POST", body });
  }

  getCase(caseId) {
    return this.request(`/v1/cases/${caseId}`);
  }

  listCases(externalRef) {
    const query = externalRef ? `?externalRef=${encodeURIComponent(externalRef)}` : "";
    return this.request(`/v1/cases${query}`);
  }

  submitIntake(caseId, body) {
    return this.request(`/v1/cases/${caseId}/intake`, { method: "POST", body });
  }

  applyPreset(caseId, presetId, autonomyMode) {
    return this.request(`/v1/cases/${caseId}/preset`, {
      method: "POST",
      body: { presetId, autonomyMode }
    });
  }

  discover(caseId, pastedUrls) {
    return this.request(`/v1/cases/${caseId}/discover`, {
      method: "POST",
      body: { pastedUrls }
    });
  }

  run(caseId) {
    return this.request(`/v1/cases/${caseId}/run`, { method: "POST", body: {} });
  }

  runUntilBlocked(caseId, maxIterations) {
    return this.request(`/v1/cases/${caseId}/run-until-blocked`, {
      method: "POST",
      body: { maxIterations }
    });
  }

  getStatus(caseId) {
    return this.request(`/v1/cases/${caseId}/status`);
  }

  getApprovals(caseId) {
    return this.request(`/v1/cases/${caseId}/approvals`);
  }

  approve(approvalId, userConfirmation) {
    return this.request(`/v1/approvals/${approvalId}/approve`, {
      method: "POST",
      body: { userConfirmation }
    });
  }

  execute(actionId, handoff) {
    return this.request(`/v1/actions/${actionId}/execute`, {
      method: "POST",
      body: handoff ?? {}
    });
  }

  confirmExposure(caseId, exposureId) {
    return this.request(`/v1/cases/${caseId}/exposures/${exposureId}/confirm`, { method: "POST", body: {} });
  }

  registerWebhookInbox() {
    return this.request("/v1/webhooks/register-inbox", { method: "POST", body: {} });
  }

  getWebhookInbox() {
    return this.request("/v1/partners/me/webhook-inbox");
  }

  getUsage() {
    return this.request("/v1/partners/me/usage");
  }

  getRuntimeBadge() {
    return fetch(`${this.baseUrl}/v1/trust/runtime`).then((response) => response.json());
  }

  deleteCase(caseId) {
    return this.request(`/v1/cases/${caseId}`, { method: "DELETE" });
  }

  exportCase(caseId) {
    return this.request(`/v1/cases/${caseId}/export`);
  }

  getBalance() {
    return this.request("/v1/billing/balance");
  }

  listInvoices() {
    return this.request("/v1/billing/invoices");
  }

  getInvoice(invoiceId) {
    return this.request(`/v1/billing/invoices/${invoiceId}`);
  }

  closeInvoicePeriod(period) {
    return this.request("/v1/billing/invoices/close", {
      method: "POST",
      body: { period }
    });
  }

  getDeliveries(options = {}) {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/v1/webhooks/deliveries${query}`);
  }

  retryDelivery(deliveryId) {
    return this.request(`/v1/webhooks/deliveries/${deliveryId}/retry`, { method: "POST", body: {} });
  }

  retryFailedDeliveries(limit) {
    return this.request("/v1/webhooks/deliveries/retry-failed", {
      method: "POST",
      body: { limit }
    });
  }

  getDataAccessLog(options = {}) {
    const params = new URLSearchParams();
    if (options.caseId) params.set("caseId", options.caseId);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/v1/partners/me/data-access${query}`);
  }
}