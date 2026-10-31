# Routing

- **Routing:** a `recipe:<name>` label wins; otherwise a lean router call picks one and explains why (planned, #227); `foedrum mash` has the Innkeeper suggest a recipe and a person choose it ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)); a human can override before work starts.
  In M1 the intake orders a Brewery issue only when an allow-listed user opened it with a `recipe:<name>` label and it is not labelled `foedrum:sub-order` ([ADR 0285](../../adr/0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md)), and each pass routes every Ordered batch whose issue it read by its one such label, whoever ordered it (this pass, a pass killed before it routed, a retry from Stuck on routing).
  Two labels or a recipe the Brewery lacks is reported once; no label waits for the routing deadline, then Stuck on routing.
  A batch whose recipe brews its `concurrency` waits Ordered, is reported once and keeps its routing deadline ([limits](limits.md)).
  Labels count only while a batch is Ordered: a relabel after routing changes nothing ([ADR 0068](../../adr/0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
  `foedrum mash <issue>` routes a Brewery issue's Ordered or routing-Stuck batch, a claimed order's included, to `mash-in`, whose Innkeeper asks which recipe brews it; the answer chooses the recipe, restarts the batch on it and labels the issue `recipe:<name>` once, through the ledger, for its next order ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
  Nothing is mashed by itself: an unlabelled issue still waits for the routing deadline.
  A claimed batch is routed by its Brewery issue's label, never its target issue's ([target issues](target-issues.md), [ADR 0156](../../adr/0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md)).
