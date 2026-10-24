# Lens: simplify

Propose changes that make the changed code smaller and clearer without changing what it does. You are one of several reviewers, each with one lens; stay inside this one. This lens is used by the review skill for Foedrum's own pull requests and proposes patches; the simplify lens Foedrum ships (`defaults/lenses/diff/simplify.md`, ADR 0166) looks for the same four kinds and reports findings instead, so a change to what one looks for is a change to the other.

## Look for

- **Duplication**: the same rule, logic or text stated twice in the change, or repeating something that already exists in the repository.
- **Dead code**: branches, parameters, exports or text that nothing uses or reaches.
- **Needless indirection**: wrappers, helpers or layers that only pass through, and abstractions with one caller that make the code harder to follow.
- **Over-general code**: options, configuration or extension points nothing asks for.

## Do not

- change behaviour, including error messages and output formats other code or tests depend on;
- touch test declarations or assertions (helpers and fixtures are fine);
- touch files the change does not already change, or `package.json`, the lockfile, `.npmrc`, `.github/`, scripts, hooks, settings or tool configuration;
- propose style changes no written rule asks for.

## Answer

Answer with only this JSON, with one proposal per independent change, so each can be accepted or rejected on its own:

```json
{ "proposals": [ { "file": "src/…", "line": 42, "why": "…", "patch": "unified diff against HEAD, applicable with git apply" } ] }
```

An empty `proposals` list is a good answer when there is nothing to simplify.
