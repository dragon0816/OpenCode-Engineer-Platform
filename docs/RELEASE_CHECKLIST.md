
# Release candidate checklist

## Technical Lead

- [ ] Verify lint, typecheck, unit, contract, ingest, knowledge, Telegram, compliance, install, backup, upgrade, rollback, and both determinism gates on the candidate source.
- [ ] Verify the GitHub Windows CI run and the uploaded ZIP, SBOM and SHA256SUMS. Check both variants against their recorded hashes and confirm a zero-hit release scan.
- [ ] Run the synthetic web, Chromium, SOP-to-Excel and knowledge flows. Confirm baseline Recall@5 of 24/24.
- [ ] Confirm the owner has signed off on remaining gates and merge through `npm run merge-check`.

## Owner

- [ ] Approve redistribution terms, embedded runtime terms and AEP provenance. Review every exception in the license allowlist. [License review](validation/p5-license-review.md) · [Allowlist](../config/license-allowlist.json)
- [ ] Run the clean-VM exercise for both variants. Verify the per-user Start menu and desktop shortcuts and scheduled task during actual logon. [Clean-VM runbook](validation/p5-clean-vm-runbook.md)
- [ ] Validate real Gateway and Telegram separately using owner-managed credentials. Exercise real credential rebinding after restore without recording values.
- [ ] Exercise backup and restore in the owner environment. Record RPO ≤24 hours and RTO ≤30 minutes with reconciliation evidence.
- [ ] Record the disposition of O-3b and every other unverified gate before calling the release candidate ready.
