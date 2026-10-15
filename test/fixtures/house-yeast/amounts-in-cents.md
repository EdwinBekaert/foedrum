---
{
  "id": "amounts-in-cents",
  "scope": { "globs": ["billing/**"], "language": "typescript", "lens": "correctness" },
  "kind": "semantic",
  "source": "https://github.com/acme/billing/pull/42#discussion_r1",
  "created": "2026-10-15",
  "status": "active", // retired rules stay for their history
}
---
In `billing/`, amounts are integers in cents; never use floating point for money.
