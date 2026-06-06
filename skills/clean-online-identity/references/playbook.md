# Operator Playbook

Use this reference when running an identity cleanup case.

## Intake

Collect only what is needed for the immediate task:

- Legal name, common aliases, and former names.
- City and state or country, plus previous cities if people-search matching requires them.
- Email addresses and phone numbers to search or protect.
- Current and prior addresses only when needed to match broker profiles or submit a request.
- Jurisdiction or residency for legal-rights templates.
- Safety constraints, such as stalking risk, domestic violence risk, minor status, public figure exposure, employer visibility, or active address threats.

Do not collect full Social Security numbers, full government ID numbers, passwords, payment details, or copies of identity documents unless a specific official process requires them and the user explicitly approves handling them.

## Case Workspace

Use `scripts/make_case_workspace.py` when the user wants durable tracking. Prefer a neutral case name like initials, month, or pseudonym. The script creates private directories and files, plus:

- `tracker.csv` for exposures and request status.
- `approvals.csv` for search and submission approvals.
- `sources_checked.csv` for official pages, opt-out URLs, deadlines, and service claims.
- `followups.csv` for response windows and rechecks.
- `risk_register.md` for high-risk safety issues.
- `backups/` for timestamped backups when scaffold files are rewritten with `--force`.

Keep screenshots and exported pages in the evidence folders. Redact screenshots before sharing them outside the case.

## Search Approval

Ask before searching with sensitive identifiers such as phone number, email address, home address, date of birth, relatives' names, workplace, or government identifiers. State what will be searched and why.

Record approval with:

- Identifier or data category approved.
- Search destination or search engine.
- Purpose and expiration.
- Whether results may expose the user's data to a third-party service.

## Exposure Discovery

Start with low-risk searches:

- Search major search engines for name plus city, then expand only with approved identifiers.
- Search common people-search sites only with approved identifiers.
- Search official registries or trusted nonprofit directories for broker contact paths when relevant.
- Use Google Results about you for Google search-result monitoring and removal requests when the user has a Google account and is eligible.

For each hit, capture profile URL or search-result URL, visible data categories, confidence, official opt-out path, verification method, and any confirmation step.

## Data Broker And People-Search Requests

Use the broker's official opt-out path when available. If no form is available, use a privacy email, postal address, or regulator registry contact. Do not use third-party opt-out pages unless the user specifically wants a paid or delegated service.

Before submission, tell the user:

- Broker or site receiving the request.
- Profile or record to remove.
- Personal data being sent for matching or verification.
- Expected confirmation step.
- Risk that the broker may retain request metadata.

Submit only after approval for that broker or site. If the site sends a confirmation email, tell the user what to look for and record whether it was completed.

## Search Result Removals

Distinguish two layers:

- Source page: request removal from the site or broker that hosts the page.
- Search result: request search-engine suppression for eligible personal information.

Explain that search-result removal does not delete the source page. For Google Results about you, use the official workflow and track request status.

## High-Risk Safety Path

Use this path for stalking, domestic violence, minors, address exposure, public figure threats, doxxing, or employer-sensitive exposure.

Prioritize:

- Current address, phone, relatives, children's data, workplace, school, and routine-location exposure.
- Source-page removal over search-result-only suppression.
- Family-member profile leakage that reveals the user's address.
- Phone carrier account PIN, email security, and MFA/passkeys before broad broker work if account takeover risk exists.
- Address confidentiality programs, victim advocacy resources, legal counsel, or law enforcement only when the user asks or the risk requires immediate non-agent help.

Keep evidence minimal, factual, and local. Do not repeat exposed address details in summaries unless necessary.

## Follow-Up And Escalation

Escalate only after checking current official complaint paths. Prepare an evidence packet with:

- Request date and destination.
- Source check date and URL.
- Copy of request text.
- Confirmation receipts or screenshots.
- Response or non-response.
- Harm or risk caused by continued publication.
- Jurisdiction and law or right invoked, when applicable.

For non-response, use `follow-up-request.md` first. Then prepare `escalation-notes.md` and ask the user before submitting complaints.
