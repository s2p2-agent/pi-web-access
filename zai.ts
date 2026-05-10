import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";
import type { ExtractedContent } from "./extract.js";

const ZAI_SEARCH_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_READER_MCP_URL = "https://api.z.ai/api/mcp/web_reader/mcp";
const ZAI_SEARCH_TOOL_NAME = "web_search_prime";
const ZAI_READER_TOOL_NAME = "webReader";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	zaiApiKey?: unknown;
}

interface ZaiMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

let cachedConfig: WebSearchConfig | null = null;
let cachedApiKey: string | null | undefined = undefined;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Resolve z.ai API key.
 * Priority: cached → model registry lookup → config file → env var.
 */
export async function resolveZaiApiKey(
	modelRegistry?: {
		getAvailable(): Promise<Array<{ provider: string }>>;
		getApiKeyAndHeaders(model: { provider: string }): Promise<{ ok: boolean; apiKey?: string }>;
	},
): Promise<string | null> {
	if (cachedApiKey !== undefined) return cachedApiKey;

	// 1. Try model registry
	if (modelRegistry) {
		try {
			const available = await modelRegistry.getAvailable();
			const zaiModel = available.find((m) => m.provider === "zai");
			if (zaiModel) {
				const auth = await modelRegistry.getApiKeyAndHeaders(zaiModel);
				if (auth.ok && auth.apiKey) {
					cachedApiKey = auth.apiKey;
					return cachedApiKey;
				}
			}
		} catch {
			// Registry not available or no zai provider, continue to fallbacks
		}
	}

	// 2. Config file
	const configKey = normalizeApiKey(loadConfig().zaiApiKey);
	if (configKey) {
		cachedApiKey = configKey;
		return cachedApiKey;
	}

	// 3. Environment variable
	const envKey = normalizeApiKey(process.env.ZAI_API_KEY);
	if (envKey) {
		cachedApiKey = envKey;
		return cachedApiKey;
	}

	cachedApiKey = null;
	return null;
}

/** Invalidate cached API key (called on session change). */
export function invalidateZaiApiKeyCache(): void {
	cachedApiKey = undefined;
}

export function isZaiAvailable(): boolean {
	if (normalizeApiKey(loadConfig().zaiApiKey)) return true;
	if (normalizeApiKey(process.env.ZAI_API_KEY)) return true;
	if (cachedApiKey) return true;
	// Optimistic: before the first resolveZaiApiKey() call, a model registry key
	// might be available. After resolution sets cachedApiKey to null, we return false.
	// This is a best-effort synchronous check — callers should handle search failures.
	return cachedApiKey === undefined;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function callZaiMcp(
	endpoint: string,
	toolName: string,
	args: Record<string, unknown>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const baseHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		"Accept": "application/json, text/event-stream",
		"Authorization": `Bearer ${apiKey}`,
	};

	// Step 1: Initialize MCP session
	const initResponse = await fetch(endpoint, {
		method: "POST",
		headers: baseHeaders,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "pi-web-access", version: "1.0" },
			},
		}),
		signal: requestSignal(signal),
	});

	if (!initResponse.ok) {
		const errorText = await initResponse.text();
		throw new Error(`z.ai MCP initialize error ${initResponse.status}: ${errorText.slice(0, 300)}`);
	}

	// Capture session ID from response headers
	const sessionId = initResponse.headers.get("mcp-session-id");
	if (!sessionId) {
		throw new Error("z.ai MCP did not return a session ID");
	}

	// Parse initialize response to confirm it worked
	await parseSseResponse(await initResponse.text());

	// Step 2: Send initialized notification
	await fetch(endpoint, {
		method: "POST",
		headers: {
			...baseHeaders,
			"Mcp-Session-Id": sessionId,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		}),
		signal: requestSignal(signal),
	});

	// Step 3: Call the tool with session
	const toolResponse = await fetch(endpoint, {
		method: "POST",
		headers: {
			...baseHeaders,
			"Mcp-Session-Id": sessionId,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!toolResponse.ok) {
		const errorText = await toolResponse.text();
		throw new Error(`z.ai MCP tool call error ${toolResponse.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await toolResponse.text();
	const parsed = await parseSseResponse(body);

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		const message = parsed.error.message || "Unknown error";
		throw new Error(`z.ai MCP error${code}: ${message}`);
	}

	if (parsed.result?.isError) {
		const message =
			parsed.result.content
				?.find((item) => item.type === "text" && typeof item.text === "string")
				?.text?.trim();
		throw new Error(message || "z.ai MCP returned an error");
	}

	const text = parsed.result?.content
		?.find(
			(item) =>
				item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
		)
		?.text;

	if (!text) {
		throw new Error("z.ai MCP returned empty content");
	}

	return text;
}

/** Parse SSE or plain JSON response from z.ai MCP. */
async function parseSseResponse(body: string): Promise<ZaiMcpRpcResponse> {
	// Try parsing SSE-style response (data: lines)
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ZaiMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				return candidate;
			}
		} catch {
			// Try next line
		}
	}

	// Fallback: try parsing entire body as JSON
	try {
		const candidate = JSON.parse(body) as ZaiMcpRpcResponse;
		if (candidate?.result || candidate?.error) {
			return candidate;
		}
	} catch {
		// Not JSON
	}

	throw new Error("z.ai MCP returned an empty response");
}

// --- Search (webSearchPrime) ---

function parseSearchResults(text: string): { answer: string; results: Array<{ title: string; url: string; snippet: string }> } {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const seen = new Set<string>();

	// z.ai returns a JSON array of search results
	try {
		const items = JSON.parse(text) as Array<{ title?: string; link?: string; content?: string; refer?: string }>;
		if (Array.isArray(items)) {
			for (const item of items) {
				const url = item.link || "";
				if (!url || seen.has(url)) continue;
				seen.add(url);
				results.push({
					title: item.title || new URL(url).hostname,
					url,
					snippet: item.content || "",
				});
			}
			if (results.length > 0) {
				const answer = items
					.map((item, i) => `${i + 1}. ${item.title || "Source"}\n   ${item.link || ""}\n   ${item.content || ""}`)
					.join("\n\n");
				return { answer, results };
			}
		}
	} catch {
		// Not JSON, fall through to text parsing
	}

	// Fallback: extract markdown links as sources
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of text.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}

	return { answer: text, results };
}

export interface ZaiSearchOptions extends SearchOptions {
	zaiApiKey?: string;
}

export async function searchWithZai(
	query: string,
	options: ZaiSearchOptions = {},
): Promise<SearchResponse> {
	const apiKey = options.zaiApiKey ?? (await resolveZaiApiKey()) ?? "";
	if (!apiKey) {
		throw new Error(
			"z.ai API key not found. Either:\n" +
				'  1. Add z.ai as a provider in pi (the same key is reused)\n' +
				`  2. Set zaiApiKey in ${CONFIG_PATH}\n` +
				"  3. Set ZAI_API_KEY environment variable",
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const mcpArgs: Record<string, unknown> = {
			search_query: query,
			location: "us",
		};

		if (options.recencyFilter) {
			const recencyMap: Record<string, string> = {
				day: "oneDay",
				week: "oneWeek",
				month: "oneMonth",
				year: "oneYear",
			};
			mcpArgs.search_recency_filter = recencyMap[options.recencyFilter] || "noLimit";
		}

		const text = await callZaiMcp(
			ZAI_SEARCH_MCP_URL,
			ZAI_SEARCH_TOOL_NAME,
			mcpArgs,
			apiKey,
			options.signal,
		);

		const { answer, results } = parseSearchResults(text);
		activityMonitor.logComplete(activityId, 200);

		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

// --- Reader (webReader) ---

export async function readWithZai(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `zai-reader: ${url}` });

	try {
		const text = await callZaiMcp(
			ZAI_READER_MCP_URL,
			ZAI_READER_TOOL_NAME,
			{ url },
			apiKey,
			signal,
		);

		activityMonitor.logComplete(activityId, 200);

		if (!text || text.trim().length === 0) return null;

		const titleMatch = text.match(/^#{1,2}\s+(.+)/m);
		const title = titleMatch ? titleMatch[1].replace(/\*+/g, "").trim() : new URL(url).hostname;

		return {
			url,
			title,
			content: text,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
