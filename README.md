# pi-local-classifier

A [Pi coding-agent](https://github.com/earendil-works/pi) extension that turns localhost typed-decision backends into native Pi classifiers. Run a small decision model beside Pi, point this extension at it, and every Pi extension can call it through `ctx.modelRegistry.classify()` — approvals, routing, ranking, and judging with no cloud round trip, no API key, and no per-call cost.

This package is backend-agnostic: it works with any server speaking the wire format below. It neither bundles nor requires any specific model.

## Install

```bash
pi install npm:pi-local-classifier
```

Requires Pi 1.0 or later (uses the native classifier registry).

## Configure

List backends as `id=url` pairs before starting Pi:

```bash
export LOCAL_CLASSIFIERS="decide=http://127.0.0.1:8133,extra=http://127.0.0.1:8000"
```

Each entry registers as `local-classifier/<id>`. Malformed entries are skipped with a warning; with nothing configured the provider stays unregistered and classifier consumers fall back gracefully. Check registration and backend health anytime with `/classifier-status`.

## Use from an extension

```typescript
const clf =
  ctx.modelRegistry.findOfType("classifier", "local-classifier", "decide") ??
  ctx.modelRegistry.getModelsOfType("classifier")[0];
if (!clf) return fallback();
const result = await ctx.modelRegistry.classify(
  clf,
  {
    state: { command },
    questions: {
      destructive: {
        type: "bool",
        instructions: "Is this operation hard to reverse?",
        criteria: { true: "data loss that is hard to recover", false: "easily reversible" },
      },
    },
  },
  { signal: ctx.signal },
);
if (result.stopReason !== "stop") return fallback();
const p = result.answers.destructive; // { type: "bool", probability: 0.97 }
```

Notes for consumer authors:

- Prefer a pinned model id when your logic depends on absolute thresholds — calibration does not transfer across backends. Relative uses (ranking, argmax routing) can take the first available classifier.
- `classify` never rejects: failures arrive as `stopReason: "error"` (or `"aborted"`). Check it before reading `answers`.
- Keep a non-classifier fallback (heuristics, recency, fail-open/closed per your policy) so the extension works with no backends configured.

## Compatibility

Backends must implement SystemOne-style input/output: `POST <base>/v1/systemone` with `{ model, state, questions }`, where questions are `bool` (sent as the wire type `noul`, with `true`/`false` criteria folded into the instructions), `choice`, or `score`; responses carry `answers` keyed by question id plus `usage.input_tokens`. Any server implementing that schema — open or proprietary, local or remote — works; the examples above use localhost because private, free, ~100ms judgments are the point.

## Development

```bash
npm test   # node --test, no dependencies to install
```

Layout: `extensions/local-classifier.ts` is the whole extension; `tests/local-classifier/` holds the `node --test` suite (registration, env parsing, question/answer mapping, per-model routing, abort behavior).

## License

MIT
