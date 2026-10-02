# Changelog

## 0.1.0 — Initial release

- Register localhost typed-decision backends from `LOCAL_CLASSIFIERS` as `local-classifier/<id>`.
- Map Pi `bool`/`choice`/`score` questions onto the SystemOne-compatible wire format and back.
- Per-model base URLs, 3s timeouts, abort propagation, `/classifier-status` health command.
- Graceful no-op with nothing configured.
- `node --test` suite for registration, parsing, mapping, routing, and abort behavior.
