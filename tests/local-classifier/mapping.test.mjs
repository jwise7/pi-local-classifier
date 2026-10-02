import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXT_URL = pathToFileURL(
	join(new URL(import.meta.url).pathname, "..", "..", "..", "extensions", "local-classifier.ts"),
).href;
let loadCount = 0;
async function loadExtension() {
	const mod = await import(`${EXT_URL}?fresh=${loadCount++}`);
	return mod.default;
}

const MODEL = { id: "clef-flash", baseUrl: "http://127.0.0.1:8133" };

async function loadProvider(env = "clef-flash=http://127.0.0.1:8133") {
	const had = process.env.LOCAL_CLASSIFIERS;
	if (env == null) delete process.env.LOCAL_CLASSIFIERS;
	else process.env.LOCAL_CLASSIFIERS = env;
	try {
		const captured = {};
		const pi = {
			on: () => () => {},
			registerCommand: () => {},
			registerProvider: (id, config) => {
				captured.id = id;
				captured.config = config;
			},
		};
		(await loadExtension())(pi);
		return captured;
	} finally {
		if (had === undefined) delete process.env.LOCAL_CLASSIFIERS;
		else process.env.LOCAL_CLASSIFIERS = had;
	}
}

function stubFetch(answerPayload, seen) {
	return async (_url, init) => {
		seen.body = JSON.parse(init.body);
		return { ok: true, json: async () => answerPayload };
	};
}

describe("local-classifier provider", () => {
	it("registers nothing without configured models", async () => {
		const { id, config } = await loadProvider(null);
		assert.equal(id, undefined, "registerProvider not called");
		assert.equal(config, undefined);
	});

	it("registers each configured model with its own base URL", async () => {
		const { id, config } = await loadProvider("clef-flash=http://127.0.0.1:8133,von=http://127.0.0.1:8000");
		assert.equal(id, "local-classifier");
		assert.equal(config.models.length, 2);
		assert.equal(config.models[0].type, "classifier");
		assert.equal(config.models[0].id, "clef-flash");
		assert.equal(config.models[0].baseUrl, "http://127.0.0.1:8133");
		assert.equal(config.models[1].id, "von");
		assert.equal(config.models[1].baseUrl, "http://127.0.0.1:8000");
		assert.ok(config.classifiers["local-classifier"], "classifier impl present");
	});

	it("folds bool criteria into a noul question and maps the answer back", async () => {
		const { config } = await loadProvider();
		const seen = {};
		const classify = config.classifiers["local-classifier"].classify;
		const result = await classify(
			MODEL,
			{
				state: { command: "rm -rf /" },
				questions: {
					destructive: {
						type: "bool",
						instructions: "Is this destructive?",
						criteria: { true: "hard to recover", false: "easily reversible" },
					},
				},
			},
			{
				fetch: stubFetch(
					{ answers: { destructive: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 150 } },
					seen,
				),
			},
		);
		assert.equal(seen.body.questions.destructive.type, "noul");
		assert.match(seen.body.questions.destructive.instructions, /hard to recover/);
		assert.match(seen.body.questions.destructive.instructions, /easily reversible/);
		assert.deepEqual(result.answers, { destructive: { type: "bool", probability: 0.97 } });
		assert.equal(result.stopReason, "stop");
		assert.equal(result.model, "clef-flash");
		assert.equal(result.provider, "local-classifier");
		assert.equal(result.usage.input, 150);
	});

	it("passes choice and score questions through with their criteria", async () => {
		const { config } = await loadProvider();
		const seen = {};
		const classify = config.classifiers["local-classifier"].classify;
		const result = await classify(
			MODEL,
			{
				state: { task: "triage" },
				questions: {
					risk: {
						type: "choice",
						instructions: "Rate the risk",
						criteria: { safe: "harmless", risky: "careful" },
					},
					level: { type: "score", instructions: "How bad?", criteria: ["low", "high"] },
				},
			},
			{
				fetch: stubFetch(
					{
						answers: {
							risk: { type: "choice", choice: "safe", confidence: 0.9, probabilities: { safe: 0.9, risky: 0.1 } },
							level: { type: "score", score: 0.2, confidence: 0.8 },
						},
						usage: { input_tokens: 200 },
					},
					seen,
				),
			},
		);
		assert.equal(seen.body.questions.risk.type, "choice");
		assert.deepEqual(seen.body.questions.risk.criteria, { safe: "harmless", risky: "careful" });
		assert.equal(seen.body.questions.level.type, "score");
		assert.equal(result.answers.risk.choice, "safe");
		assert.equal(result.answers.level.score, 0.2);
	});

	it("routes each model to its own base URL", async () => {
		const { config } = await loadProvider();
		let seenUrl = "";
		const classify = config.classifiers["local-classifier"].classify;
		const result = await classify(
			{ id: "von", baseUrl: "http://127.0.0.1:9999/" },
			{
				state: { command: "ls" },
				questions: { q: { type: "bool", instructions: "x?", criteria: { true: "y", false: "n" } } },
			},
			{
				fetch: async (url, init) => {
					seenUrl = url;
					assert.match(JSON.parse(init.body).model, /^von$/);
					return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.5 } } }) };
				},
			},
		);
		assert.equal(seenUrl, "http://127.0.0.1:9999/v1/systemone");
		assert.equal(result.model, "von");
	});

	it("throws when the model has no base URL", async () => {
		const { config } = await loadProvider();
		const classify = config.classifiers["local-classifier"].classify;
		await assert.rejects(
			classify(
				{ id: "nowhere" },
				{ state: {}, questions: { q: { type: "bool", instructions: "x?", criteria: { true: "y", false: "n" } } } },
				{
					fetch: async () => {
						throw new Error("fetch must not run without a URL");
					},
				},
			),
			/no base URL/,
		);
	});

	it("throws when the backend omits an answer", async () => {
		const { config } = await loadProvider();
		const classify = config.classifiers["local-classifier"].classify;
		await assert.rejects(
			classify(
				MODEL,
				{ state: {}, questions: { q: { type: "bool", instructions: "x?", criteria: { true: "y", false: "n" } } } },
				{ fetch: stubFetch({ answers: {}, usage: {} }, {}) },
			),
			/omitted answer/,
		);
	});

	it("throws the abort reason when the caller already aborted", async () => {
		const { config } = await loadProvider();
		const classify = config.classifiers["local-classifier"].classify;
		const ctrl = new AbortController();
		ctrl.abort(new Error("turn aborted"));
		await assert.rejects(
			classify(
				MODEL,
				{ state: {}, questions: { q: { type: "bool", instructions: "x?", criteria: { true: "y", false: "n" } } } },
				{
					signal: ctrl.signal,
					fetch: async () => {
						throw new Error("fetch must not run after abort");
					},
				},
			),
			/turn aborted/,
		);
	});
});

describe("local-classifier model parsing", () => {
	it("parses valid entries and skips malformed or duplicate ones", async () => {
		const mod = await import(`${EXT_URL}?fresh=${loadCount++}`);
		const specs = mod.parseModels(
			"clef-flash=http://127.0.0.1:8133, broken-entry, =http://x, dup=http://a, dup=http://b, ftp=http://[::1",
		);
		assert.deepEqual(
			specs.map((s) => s.id).sort(),
			["clef-flash", "dup", "ftp"],
			"keeps valid ids, drops malformed and duplicate entries",
		);
		assert.equal(specs.find((s) => s.id === "clef-flash").baseUrl, "http://127.0.0.1:8133");
		assert.deepEqual(mod.parseModels(""), []);
		process.env.LOCAL_CLASSIFIERS = "from-env=http://127.0.0.1:7777";
		try {
			assert.deepEqual(mod.parseModels(), [{ id: "from-env", baseUrl: "http://127.0.0.1:7777" }]);
		} finally {
			delete process.env.LOCAL_CLASSIFIERS;
		}
	});
});
