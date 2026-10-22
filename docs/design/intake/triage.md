# Triage

**Triage.** Issues filed in target repositories configured as triage sources (bug reports, user requests) go to the Infection check recipe instead.
It reads them — selected by repository and label/filter, by explicit references, or on a schedule — reproduces the problem in a clean worktree, confirms the root cause at file and line, and records the findings as one or more **orders in the Brewery** that link back to the source issue.
It stops there: it never fixes, assigns, labels or closes anything in the target repository.
Commenting a link back on the source issue is an opt-in setting.
