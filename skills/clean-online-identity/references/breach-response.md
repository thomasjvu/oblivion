# Breach And Dark-Web Response

Use this reference when the user mentions breached data, dark-web monitoring, credential exposure, identity theft, suspicious account activity, or exposed Social Security numbers.

## Core Position

Do not promise deletion from the dark web. Once data is in breach dumps or criminal markets, the practical response is risk reduction, account recovery, monitoring, and identity-theft mitigation.

Do not crawl dark-web forums, buy leaked data, search breach dumps, join illicit channels, or provide instructions for obtaining stolen data.

## Safe Checks

- Check email exposure with Have I Been Pwned only when the user approves the email address check.
- Do not ask for passwords. For password exposure checks, use the Pwned Passwords k-anonymity range flow or direct the user to a reputable password manager's breach checker.
- Record the source, date checked, and result category in `sources_checked.csv`; avoid storing breach details that are not needed for action.

## Priority Recovery Order

1. Secure primary email accounts.
2. Secure password manager, Apple, Google, Microsoft, and phone carrier accounts.
3. Rotate reused or exposed passwords.
4. Enable passkeys or phishing-resistant MFA where available; use authenticator apps where passkeys are unavailable.
5. Review recovery emails, recovery phone numbers, sessions, forwarding rules, app passwords, and OAuth grants.
6. Freeze credit with Equifax, Experian, and TransUnion when US identity risk exists.
7. Add a fraud alert if identity theft is suspected.
8. Use IdentityTheft.gov when misuse occurred or when the user needs a recovery plan and report.
9. Review bank, brokerage, tax, healthcare, payroll, benefits, and government accounts.
10. Monitor mail, phone carrier changes, SIM-swap risk, and suspicious account notices.

## Output

Return a mitigation plan with:

- Affected identifiers checked or approved for checking.
- Account categories at risk.
- Immediate lock-down actions.
- Credit or identity-theft steps.
- Follow-up dates.
- Items that require the user to act directly because credentials or sensitive identity proof must not be handled by the agent.
