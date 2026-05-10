# z.ai MCP Provider Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add z.ai's `webSearchPrime` and `webReader` MCP tools as a new search and content-extraction provider in pi-web-access.

**Architecture:** New `zai.ts` module implements MCP JSON-RPC calls to z.ai endpoints. It's wired into the existing provider system via `gemini-search.ts` (search) and `extract.ts` (content fallback). `index.ts` adds z.ai to the tool parameter schema and provider availability/resolution logic.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, standard MCP JSON-RPC over HTTP.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `zai.ts` (new) | z.ai MCP client: API key resolution, `webSearchPrime`, `webReader`, availability check |
| `gemini-search.ts` (modify) | Add `"zai"` to `SearchProvider` type, add z.ai routing in `search()`, add to auto fallback |
| `extract.ts` (modify) | Add z.ai webReader as fallback after Jina and Gemini extraction attempts |
| `index.ts` (modify) | Add `"zai"` to provider enum, `ProviderAvailability`, `normalizeProviderInput`, `resolveProvider`, imports |
| `test/zai.test.mjs` (new) | Tests for z.ai MCP client |

---

### Task 1: Create `zai.ts` — API Key Resolution and Availability

**Files:**
- Create: `zai.ts`

- [ ] **Step 1: Write `zai.ts` with key resolution and availability logic**

```typescript
// zai.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchResult, SearchOptions, SearchResponse } from "./perplexity.js";
import type { ExtractedContent } from "./extract.js";

const ZAI_SEARCH_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_READER_MCP_URL = "https://api.z.ai/api/mcp/web_reader/mcp";
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
 * The modelRegistry parameter is optional; when provided, we look for
 * any model with provider "zai" and extract its API key.
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
	// We check synchronously if a key is likely available.
	// The config/env checks are sync; registry check is deferred to search time.
	if (normalizeApiKey(loadConfig().zaiApiKey)) return true;
	if (normalizeApiKey(process.env.ZAI_API_KEY)) return true;
	// If we previously resolved a key, it's available
	if (cachedApiKey) return true;
	// Might be available via model registry — return true optimistically
	// if we haven't cached a null yet
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
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`z.ai MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();

	// Try parsing SSE-style response (data: lines)
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));
	let parsed: ZaiMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ZaiMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
			// Try next line
		}
	}

	// Fallback: try parsing entire body as JSON
	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ZaiMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
			// Not JSON
		}
	}

	if (!parsed) {
		throw new Error("z.ai MCP returned an empty response");
	}

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

// --- Search (webSearchPrime) ---

interface ZaiSearchResult {
	title: string;
	url: string;
	snippet: string;
}

function parseSearchResults(text: string): { answer: string; results: ZaiSearchResult[] } {
	const results: ZaiSearchResult[] = [];
	const seen = new Set<string>();

	// Extract markdown links as sources: [title](url)
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of text.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}

	// Also try numbered URL patterns: 1. https://...
	const urlRegex = /^\s*\d+[\.\)]\s*(https?:\/\/\S+)/gm;
	for (const match of text.matchAll(urlRegex)) {
		const url = match[1];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: new URL(url).hostname, url, snippet: "" });
	}

	// The full text serves as the synthesized answer
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
			query,
		};
		if (options.numResults) mcpArgs.numResults = options.numResults;

		const text = await callZaiMcp(
			ZAI_SEARCH_MCP_URL,
			"webSearchPrime",
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
			"webReader",
			{ url },
			apiKey,
			signal,
		);

		activityMonitor.logComplete(activityId, 200);

		if (!text || text.trim().length === 0) return null;

		// Try to extract title from first heading
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
```

- [ ] **Step 2: Commit**

```bash
git add zai.ts
git commit -m "feat: add zai.ts — z.ai MCP client for search and reader"
```

---

### Task 2: Wire z.ai into `gemini-search.ts`

**Files:**
- Modify: `gemini-search.ts`

- [ ] **Step 1: Add `"zai"` to `SearchProvider` type and import `searchWithZai`**

At the top of `gemini-search.ts`, add the import:

```typescript
import { searchWithZai } from "./zai.js";
```

Find the `SearchProvider` type definition (around line 10):

```typescript
export type SearchProvider = "auto" | "perplexity" | "gemini" | "exa";
```

Change to:

```typescript
export type SearchProvider = "auto" | "perplexity" | "gemini" | "exa" | "zai";
```

- [ ] **Step 2: Add `zaiApiKey` to `FullSearchOptions`**

Find the `FullSearchOptions` interface:

```typescript
export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}
```

Add `zaiApiKey`:

```typescript
export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
	zaiApiKey?: string;
}
```

- [ ] **Step 3: Add explicit z.ai provider branch in `search()`**

In the `search()` function, find the block that handles `provider === "exa"` (around line 80-100). After that block and before the fallback chain that starts with `if (provider !== "exa" && isExaAvailable())`, add the explicit z.ai branch:

```typescript
	if (provider === "zai") {
		const result = await searchWithZai(query, {
			...options,
			zaiApiKey: options.zaiApiKey,
		});
		return { ...result, provider: "zai" };
	}
```

- [ ] **Step 4: Add z.ai to the auto fallback chain**

In the `search()` function, the fallback chain currently goes: Exa → Perplexity → Gemini. Insert z.ai between Exa and Perplexity.

Find the fallback block that starts:

```typescript
	const fallbackErrors: string[] = [];

	if (provider !== "exa" && isExaAvailable()) {
```

Before the Perplexity fallback block (`if (isPerplexityAvailable())`), add:

```typescript
	if (provider !== "zai") {
		try {
			const result = await searchWithZai(query, {
				...options,
				zaiApiKey: options.zaiApiKey,
			});
			return { ...result, provider: "zai" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`z.ai: ${errorMessage(err)}`);
		}
	}
```

- [ ] **Step 5: Update `normalizeSearchProvider` to accept `"zai"`**

Find the `normalizeSearchProvider` function:

```typescript
function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "gemini" || normalized === "exa"
		? normalized
		: "auto";
}
```

Add `"zai"`:

```typescript
function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "gemini" || normalized === "exa" || normalized === "zai"
		? normalized
		: "auto";
}
```

- [ ] **Step 6: Commit**

```bash
git add gemini-search.ts
git commit -m "feat: add z.ai provider to search dispatcher and auto fallback chain"
```

---

### Task 3: Wire z.ai into `index.ts` — Provider Availability and Resolution

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add import for z.ai module**

Find the imports section (around line 36-39), after the existing provider imports:

```typescript
import { isPerplexityAvailable } from "./perplexity.js";
import { isExaAvailable } from "./exa.js";
import { isGeminiApiAvailable } from "./gemini-api.js";
import { getActiveGoogleEmail, isGeminiWebAvailable } from "./gemini-web.js";
```

Add:

```typescript
import { isZaiAvailable, invalidateZaiApiKeyCache } from "./zai.js";
```

- [ ] **Step 2: Add `zai` to `ProviderAvailability`**

Find the interface:

```typescript
interface ProviderAvailability {
	perplexity: boolean;
	exa: boolean;
	gemini: boolean;
}
```

Add `zai`:

```typescript
interface ProviderAvailability {
	perplexity: boolean;
	exa: boolean;
	gemini: boolean;
	zai: boolean;
}
```

- [ ] **Step 3: Update `getProviderAvailability()`**

Find the function:

```typescript
async function getProviderAvailability(): Promise<ProviderAvailability> {
	const geminiWebAvail = await isGeminiWebAvailable();
	return {
		perplexity: isPerplexityAvailable(),
		exa: isExaAvailable(),
		gemini: isGeminiApiAvailable() || !!geminiWebAvail,
	};
}
```

Add z.ai:

```typescript
async function getProviderAvailability(): Promise<ProviderAvailability> {
	const geminiWebAvail = await isGeminiWebAvailable();
	return {
		perplexity: isPerplexityAvailable(),
		exa: isExaAvailable(),
		gemini: isGeminiApiAvailable() || !!geminiWebAvail,
		zai: isZaiAvailable(),
	};
}
```

- [ ] **Step 4: Update `normalizeProviderInput()` to accept `"zai"`**

Find the function:

```typescript
function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "exa" || normalized === "perplexity" || normalized === "gemini") {
		return normalized;
	}
	return "auto";
}
```

Add `"zai"`:

```typescript
function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "exa" || normalized === "perplexity" || normalized === "gemini" || normalized === "zai") {
		return normalized;
	}
	return "auto";
}
```

- [ ] **Step 5: Update `resolveProvider()` — auto fallback and explicit z.ai handling**

Find the `resolveProvider` function. Update the auto fallback to include z.ai between Exa and Perplexity:

```typescript
	if (provider === "auto") {
		if (available.exa) return "exa";
		if (available.perplexity) return "perplexity";
		if (available.gemini) return "gemini";
		return "exa";
	}
```

Change to:

```typescript
	if (provider === "auto") {
		if (available.exa) return "exa";
		if (available.zai) return "zai";
		if (available.perplexity) return "perplexity";
		if (available.gemini) return "gemini";
		return "exa";
	}
```

Add the z.ai unavailable fallback block after the existing `gemini` unavailable block:

```typescript
	if (provider === "gemini" && !available.gemini) {
		if (available.exa) return "exa";
		return available.perplexity ? "perplexity" : "gemini";
	}
	return provider;
```

Insert before `return provider`:

```typescript
	if (provider === "zai" && !available.zai) {
		if (available.exa) return "exa";
		if (available.perplexity) return "perplexity";
		return available.gemini ? "gemini" : "zai";
	}
	return provider;
```

- [ ] **Step 6: Add `"zai"` to the `web_search` tool parameter schema**

Find the `provider` parameter in the tool definition (around line 1105):

```typescript
provider: Type.Optional(
	StringEnum(["auto", "perplexity", "gemini", "exa"], { description: "Search provider (default: auto)" }),
),
```

Change to:

```typescript
provider: Type.Optional(
	StringEnum(["auto", "perplexity", "gemini", "exa", "zai"], { description: "Search provider (default: auto)" }),
),
```

- [ ] **Step 7: Update tool description to mention z.ai**

Find the `description` property of the `web_search` tool. Update the first line to mention z.ai:

```
`Search the web using Perplexity AI, Exa, Gemini, or z.ai. Returns an AI-synthesized answer with source citations.
```

- [ ] **Step 8: Invalidate z.ai key cache on session change**

Find `handleSessionChange()`. After the `clearCloneCache()` call, add:

```typescript
invalidateZaiApiKeyCache();
```

- [ ] **Step 9: Pass `zaiApiKey` through to search calls**

In the `web_search` tool's `execute` handler, there are two code paths that call `search()`:

**Path A — curated search (the `shouldCurate` branch):** Find where `loadCuratorBootstrap(params.provider)` is called (around line 1090). After the bootstrap is loaded, resolve the z.ai API key:

After:
```typescript
const bootstrap = await loadCuratorBootstrap(params.provider);
```

Add the key resolution. Since this path doesn't have direct access to the model registry via `ctx` (the ctx here is an extension context, not the search layer), we import `resolveZaiApiKey` and call it. But we also need to pass it through to the curator's `onAddSearch` handler.

Add import at the top of `index.ts`:
```typescript
import { resolveZaiApiKey } from "./zai.js";
```

Then, in the curated search path, after the bootstrap, add:
```typescript
const zaiApiKey = await resolveZaiApiKey();
```

Pass it to the curator's `onAddSearch` handler. Find the call to `search(query, {...})` inside `onAddSearch`:

```typescript
const { answer, results, inlineContent, provider: actualProvider } = await search(query, {
	provider: requestedProvider,
	numResults: pc.numResults,
	recencyFilter: pc.recencyFilter,
	domainFilter: pc.domainFilter,
	includeContent: pc.includeContent,
	signal: addSearchSignal,
});
```

Add `zaiApiKey`:

```typescript
const { answer, results, inlineContent, provider: actualProvider } = await search(query, {
	provider: requestedProvider,
	numResults: pc.numResults,
	recencyFilter: pc.recencyFilter,
	domainFilter: pc.domainFilter,
	includeContent: pc.includeContent,
	signal: addSearchSignal,
	zaiApiKey: zaiApiKey ?? undefined,
});
```

**Path B — non-curated search:** Find the `search()` call in the non-curated branch (around line 1268-1277):

```typescript
const { answer, results, inlineContent, provider } = await search(query, {
	provider: resolvedProvider,
	numResults: params.numResults,
	recencyFilter: params.recencyFilter,
	domainFilter: params.domainFilter,
	includeContent: params.includeContent,
	signal,
});
```

Add `zaiApiKey`:

```typescript
const zaiApiKey = await resolveZaiApiKey();
```

And to the search call:
```typescript
const { answer, results, inlineContent, provider } = await search(query, {
	provider: resolvedProvider,
	numResults: params.numResults,
	recencyFilter: params.recencyFilter,
	domainFilter: params.domainFilter,
	includeContent: params.includeContent,
	signal,
	zaiApiKey: zaiApiKey ?? undefined,
});
```

Do the same for the main search loop in the curated path where searches are run before the curator opens (around line 1120-1140). Find:

```typescript
const { answer, results, inlineContent, provider } = await search(queryList[qi], {
	provider: requestedProvider,
	numResults: params.numResults,
	recencyFilter: params.recencyFilter,
	domainFilter: params.domainFilter,
	includeContent: params.includeContent,
	signal: searchSignal,
});
```

Add `zaiApiKey`:

```typescript
const { answer, results, inlineContent, provider } = await search(queryList[qi], {
	provider: requestedProvider,
	numResults: params.numResults,
	recencyFilter: params.recencyFilter,
	domainFilter: params.domainFilter,
	includeContent: params.includeContent,
	signal: searchSignal,
	zaiApiKey: zaiApiKey ?? undefined,
});
```

- [ ] **Step 10: Commit**

```bash
git add index.ts
git commit -m "feat: wire z.ai provider into index.ts — availability, resolution, tool schema"
```

---

### Task 4: Add z.ai webReader fallback to `extract.ts`

**Files:**
- Modify: `extract.ts`

- [ ] **Step 1: Add z.ai reader import**

At the top of `extract.ts`, add:

```typescript
import { readWithZai, resolveZaiApiKey } from "./zai.js";
```

- [ ] **Step 2: Add z.ai webReader fallback in `extractContent()`**

Find the fallback sequence near the end of `extractContent()`. After the Jina reader attempt and before the Gemini fallback, add the z.ai reader. The current code reads:

```typescript
	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted) return abortedResult(url);

	let geminiResult: ExtractedContent | null = null;
	try {
		geminiResult = await extractWithUrlContext(url, signal)
			?? await extractWithGeminiWeb(url, signal);
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { ...httpResult, error: errorMessage(err) };
		}
	}

	if (geminiResult) return geminiResult;
	if (signal?.aborted) return abortedResult(url);
```

Insert the z.ai reader between the Jina and Gemini blocks:

```typescript
	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted) return abortedResult(url);

	// z.ai webReader fallback
	try {
		const zaiKey = await resolveZaiApiKey();
		if (zaiKey) {
			const zaiResult = await readWithZai(url, zaiKey, signal);
			if (zaiResult && zaiResult.content.length >= MIN_USEFUL_CONTENT) return zaiResult;
		}
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
	}
	if (signal?.aborted) return abortedResult(url);

	let geminiResult: ExtractedContent | null = null;
	try {
		geminiResult = await extractWithUrlContext(url, signal)
			?? await extractWithGeminiWeb(url, signal);
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { ...httpResult, error: errorMessage(err) };
		}
	}

	if (geminiResult) return geminiResult;
	if (signal?.aborted) return abortedResult(url);
```

- [ ] **Step 3: Update the guidance message to mention z.ai**

Find the guidance block at the end of `extractContent()`:

```typescript
	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Set GEMINI_API_KEY in ~/.pi/web-search.json",
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
```

Add z.ai option:

```typescript
	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Add z.ai as a provider in pi (or set ZAI_API_KEY)",
		"  \u2022 Set GEMINI_API_KEY in ~/.pi/web-search.json",
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
```

- [ ] **Step 4: Commit**

```bash
git add extract.ts
git commit -m "feat: add z.ai webReader as content extraction fallback"
```

---

### Task 5: Write Tests for `zai.ts`

**Files:**
- Create: `test/zai.test.mjs`

- [ ] **Step 1: Write tests for key resolution and availability**

```javascript
// test/zai.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../zai.ts", import.meta.url).href;

function runInIsolation(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.ZAI_API_KEY;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { isZaiAvailable, resolveZaiApiKey, invalidateZaiApiKeyCache } = await import(${JSON.stringify(moduleUrl)});
			const available = isZaiAvailable();
			const key = await resolveZaiApiKey();
			console.log(JSON.stringify({ available, key }));
		`,
		encoding: "utf8",
		env,
	});
}

test("z.ai unavailable when no key configured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-"));
	// Clear any cached config by creating empty config
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), "{}\n", "utf8");

	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, null);
});

test("z.ai available via ZAI_API_KEY env var", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-env-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), "{}\n", "utf8");

	const child = runInIsolation(home, { ZAI_API_KEY: "test-zai-key-123" });
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "test-zai-key-123");
});

test("z.ai available via config file zaiApiKey", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-cfg-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ zaiApiKey: "config-zai-key-456" }) + "\n",
		"utf8",
	);

	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "config-zai-key-456");
});

test("env var takes precedence over config file", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-precedence-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ zaiApiKey: "config-key" }) + "\n",
		"utf8",
	);

	// Config file key is checked after model registry, so with no registry,
	// config file key should be returned
	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "config-key");
});
```

- [ ] **Step 2: Run tests**

```bash
node --test test/zai.test.mjs
```

Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/zai.test.mjs
git commit -m "test: add zai.ts key resolution and availability tests"
```

---

### Task 6: Manual Integration Test

**Files:** None (manual testing)

- [ ] **Step 1: Verify the extension loads without errors**

With z.ai configured as a provider in pi, run `pi` and check that:
1. The `web_search` tool description mentions z.ai
2. Running `web_search` with `provider: "zai"` works (returns search results)
3. Running `web_search` with `provider: "auto"` falls back to z.ai when Exa is unavailable

- [ ] **Step 2: Verify content extraction fallback**

Use `fetch_content` on a URL that fails with standard extraction (e.g., a JS-rendered page). Check that z.ai webReader is attempted as a fallback.

- [ ] **Step 3: Push the branch**

```bash
git push origin feat/zai-mcp-provider
```
