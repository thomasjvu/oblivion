export class OblivionStatusBadge {
  constructor({ baseUrl, container }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.container = typeof container === "string" ? document.querySelector(container) : container;
  }

  async render() {
    const response = await fetch(`${this.baseUrl}/v1/trust/runtime`);
    const badge = await response.json();
    const klass = badge.runtimeMode === "tee-verified" ? "tee" : "local";
    this.container.innerHTML = `<span class="oblivion-status-badge oblivion-widget ${klass}">
      <span>${badge.runtimeMode === "tee-verified" ? "TEE verified" : "Local mode"}</span>
    </span>`;
    return badge;
  }
}

export class OblivionStatusPanel {
  constructor({ client, caseId, container }) {
    this.client = client;
    this.caseId = caseId;
    this.container = typeof container === "string" ? document.querySelector(container) : container;
  }

  async refresh() {
    const status = await this.client.getStatus(this.caseId);
    this.container.innerHTML = `<div class="oblivion-status-panel oblivion-widget">
      <div><strong>Phase:</strong> ${status.phase}</div>
      <div><strong>Pending approvals:</strong> ${status.pendingApprovals}</div>
      <div><strong>Confirmed exposures:</strong> ${status.confirmedExposures}</div>
      <div><strong>Removals complete:</strong> ${status.removalsComplete}</div>
      ${status.nextRecheck ? `<div><strong>Next recheck:</strong> ${status.nextRecheck}</div>` : ""}
    </div>`;
    return status;
  }
}

export class OblivionApprovalPanel {
  constructor({ client, caseId, container, contactEmail = "", onApproved, onExecuted }) {
    this.client = client;
    this.caseId = caseId;
    this.contactEmail = contactEmail;
    this.container = typeof container === "string" ? document.querySelector(container) : container;
    this.onApproved = onApproved;
    this.onExecuted = onExecuted;
  }

  async refresh() {
    const data = await this.client.getApprovals(this.caseId);
    this.container.innerHTML = "";
    if (!data.pending.length) {
      this.container.innerHTML = `<p class="oblivion-widget" style="color:#888">No pending approvals.</p>`;
      return data;
    }
    for (const approval of data.pending) {
      const action = data.actions.find((item) => item.approvalId === approval.id);
      const card = document.createElement("div");
      card.className = "oblivion-approval-card oblivion-widget";
      card.innerHTML = `
        <h4>${approval.actionType}</h4>
        <p><strong>To:</strong> ${approval.destination}</p>
        <p><strong>Discloses:</strong> ${approval.dataToDisclose.join(", ")}</p>
        <p>${approval.purpose}</p>
        <input type="text" placeholder="Type to confirm (min 8 chars)" data-input="${approval.id}" />
        <button class="primary" data-approve="${approval.id}">Approve</button>
        ${action ? `<button data-execute="${action.id}">Execute</button>` : ""}
      `;
      this.container.appendChild(card);
    }
    this.container.querySelectorAll("[data-approve]").forEach((button) => {
      button.addEventListener("click", async () => {
        const input = this.container.querySelector(`[data-input="${button.dataset.approve}"]`);
        const result = await this.client.approve(button.dataset.approve, input.value);
        this.onApproved?.(result);
        await this.refresh();
      });
    });
    this.container.querySelectorAll("[data-execute]").forEach((button) => {
      button.addEventListener("click", async () => {
        const result = await this.client.execute(button.dataset.execute, {
          emailLabel: this.contactEmail || undefined
        });
        this.onExecuted?.(result);
        await this.refresh();
      });
    });
    return data;
  }
}