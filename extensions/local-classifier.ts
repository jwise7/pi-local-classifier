import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ProviderClassifier,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Drop-in local classifier runner for Pi's native registry.
// Registers every configured typed-decision backend as
// `local-classifier/<id>` so any extension can classify via
// ctx.modelRegistry without knowing about localhost URLs:
//
//   LOCAL_CLASSIFIERS="decide=http://127.0.0.1:8133,extra=http://127.0.0.1:8000"
//
// Backends answer bool/choice/score questions over HTTP (see README
// for the wire format). Malformed entries are skipped with a warning.
// With no configured models the provider stays unregistered and
// consumers fall back gracefully.
export const PROVIDER_ID = "local-classifier";
export const API_ID = "local-classifier";

const TIMEOUT_MS = 3000;

export interface LocalModelSpec {
	id: string;
	baseUrl: string;
}

export function parseModels(env = process.env.LOCAL_CLASSIFIERS): LocalModelSpec[] {
	if (!env?.trim()) return [];
	const specs: LocalModelSpec[] = [];
	for (const part of env.split(",")) {
		const eq = part.indexOf("=");
		const id = (eq < 0 ? "" : part.slice(0, eq)).trim();
		const baseUrl = (eq < 0 ? "" : part.slice(eq + 1)).trim().replace(/\/+$/, "");
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || !/^https?:\/\/.+/.test(baseUrl)) {
			console.warn(`[local-classifier] ignoring malformed LOCAL_CLASSIFIERS entry: ${part.trim()}`);
			continue;
		}
		if (specs.some((s) => s.id === id)) {
			console.warn(`[local-classifier] ignoring duplicate LOCAL_CLASSIFIERS id: ${id}`);
			continue;
		}
		specs.push({ id, baseUrl });
	}
	return specs;
}

interface WireAnswer {
	type: string;
	noul?: number;
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	score?: number;
}

function toWireQuestions(context: ClassifierContext): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [qid, q] of Object.entries(context.questions)) {
		if (q.type === "bool") {
			// The wire format's binary question carries no criteria slots; fold them in.
			out[qid] = {
				type: "noul",
				instructions: `${q.instructions} Answer yes when: ${q.criteria.true} Answer no when: ${q.criteria.false}`,
			};
		} else {
			out[qid] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
		}
	}
	return out;
}

function toClassifierAnswer(qid: string, answer: WireAnswer): ClassifierAnswer {
	if (answer.type === "noul" && typeof answer.noul === "number") {
		return { type: "bool", probability: answer.noul };
	}
	if (
		answer.type === "choice" &&
		typeof answer.choice === "string" &&
		typeof answer.confidence === "number" &&
		answer.probabilities
	) {
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: answer.probabilities,
			confidence: answer.confidence,
		};
	}
	if (answer.type === "score" && typeof answer.score === "number" && typeof answer.confidence === "number") {
		return { type: "score", score: answer.score, confidence: answer.confidence };
	}
	throw new Error(`Classifier backend returned an unusable answer for "${qid}"`);
}

const localClassifier: ProviderClassifier = {
	async classify(
		model: ClassifierModel<any>,
		context: ClassifierContext,
		options?: { signal?: AbortSignal; fetch?: typeof fetch },
	): Promise<ClassifierResult> {
		if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		const baseUrl = (model as { baseUrl?: unknown }).baseUrl;
		if (typeof baseUrl !== "string" || !baseUrl) {
			throw new Error(`Local classifier "${model.id}" has no base URL configured`);
		}
		const fetchFn = options?.fetch ?? fetch;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new Error(`Classifier backend timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		let signal = ctrl.signal;
		if (options?.signal) signal = AbortSignal.any([options.signal, ctrl.signal]);
		try {
			const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					state: context.state,
					questions: toWireQuestions(context),
				}),
				signal,
			});
			if (!res.ok) throw new Error(`Classifier backend http ${res.status}`);
			const data = (await res.json()) as {
				answers?: Record<string, WireAnswer>;
				usage?: { input_tokens?: number };
			};
			const answers: Record<string, ClassifierAnswer> = {};
			for (const qid of Object.keys(context.questions)) {
				const raw = data.answers?.[qid];
				if (!raw) throw new Error(`Classifier backend omitted answer for "${qid}"`);
				answers[qid] = toClassifierAnswer(qid, raw);
			}
			return {
				api: API_ID,
				provider: PROVIDER_ID,
				model: model.id,
				answers,
				usage: { input: data.usage?.input_tokens ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: Date.now(),
			};
		} catch (e) {
			if (options?.signal?.aborted) throw options.signal.reason ?? e;
			throw e instanceof Error ? e : new Error(String(e));
		} finally {
			clearTimeout(timer);
		}
	},
};

export default function (pi: ExtensionAPI) {
	const specs = parseModels();
	if (specs.length > 0) {
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: specs[0].baseUrl,
			apiKey: "local-no-auth", // required by provider config; local backends take none
			classifiers: { [API_ID]: localClassifier },
			models: specs.map((s) => ({
				type: "classifier" as const,
				id: s.id,
				name: `${s.id} (local classifier)`,
				api: API_ID,
				baseUrl: s.baseUrl,
				input: ["text" as const],
				contextWindow: 16384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		});
	}

	pi.registerCommand("classifier-status", {
		description: "Show configured local classifiers and backend health",
		handler: async (_args, ctx) => {
			const found = ctx.modelRegistry.getModelsOfType("classifier", PROVIDER_ID);
			if (found.length === 0) {
				ctx.ui.notify(
					'No local classifiers configured. Set LOCAL_CLASSIFIERS="id=http://host:port,..." and reload.',
					"warning",
				);
				return;
			}
			const lines = await Promise.all(
				found.map(async (m) => {
					let health = "down";
					try {
						const base = (m as { baseUrl?: string }).baseUrl ?? "";
						const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
						if (res.ok) health = "up";
					} catch {
						health = "down";
					}
					return `${m.id} ${health}`;
				}),
			);
			ctx.ui.notify(`Local classifiers: ${lines.join(", ")}.`, "info");
		},
	});
}
