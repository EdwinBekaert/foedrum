# Routing

- **Routing:** a `recipe:<name>` label wins; otherwise a lean router call picks one and explains why; a human can override before work starts.
  In M1 the intake orders a Brewery issue only when an allow-listed user opened it with a `recipe:<name>` label, and each pass routes every Ordered batch whose issue it read by its one such label, whoever ordered it (this pass, a pass killed before it routed, a retry from Stuck on routing).
  Two labels or a recipe the Brewery lacks is reported once; no label waits for the routing deadline, then Stuck on routing.
  Labels count only while a batch is Ordered: a relabel after routing changes nothing ([ADR 0068](../../adr/0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
  A claimed batch is routed by its Brewery issue's label, never its target issue's ([target issues](target-issues.md), [ADR 0156](../../adr/0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md)).
