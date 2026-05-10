# z.ai MCP Provider Integration

**Date:** 2026-05-10  
**Status:** Draft  
**Scope:** Add z.ai's `webSearchPrime` and `webReader` MCP tools as a new search and content-extraction provider in pi-web-access.

## Background

pi-web-access currently supports three search providers: Exa (direct API or free MCP), Perplexity (API key), and Gemini (API key or browser cookies). The auto fallback chain is Exa → Perplexity → Gemini.

z.ai's GLM Coding Plan provides two MCP tools accessible via HTTP JSON-RPC:
- **`webSearchPrime`** — web search returning titles, URLs, summaries, site info
- **`webReader`** — fetch page content for a URL, returning title, main content, metadata, links

Both require a Bearer token (z.ai API key). Users who have z.ai configured as a provider in pi already have this key available through the model registry.

## Design

### 1. New file: `zai.ts`

MCP client for z.ai search and reader tools.

**Exports:**
- `isZaiAvailable(modelRegistry?): boolean` — returns true if a z.ai API key can be resolved
- `searchWithZai(query, options, apiKey)` — calls `webSearchPrime` MCP tool, returns `SearchResponse`
- `readWithZai(url, options, apiKey)` — calls `webReader` MCP tool, returns `ExtractedContent`
- `resolveZaiApiKey(modelRegistry?)` — resolves the z.ai API key from: model registry → `~/.pi/web-search.json` (`zaiApiKey`) → `ZAI_API_KEY` env var

**MCP endpoint:** `https://api.z.ai/api/mcp/web_search_prime/mcp` (search) and `https://api.z.ai/api/mcp/web_reader/mcp` (reader)

**MCP protocol:** Standard JSON-RPC 2.0 over HTTP POST:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "webSearchPrime",
    "arguments": { "query": "..." }
  }
}
```
With header `Authorization: Bearer <api_key>`.

**Search arguments** (webSearchPrime):
- `query` — the search query
- Response parsed from MCP result text to extract titles, URLs, summaries

**Reader arguments** (webReader):
- `url` — the URL to read
- Response parsed from MCP result text to extract title, content, metadata

**Response parsing:** Parse the MCP JSON-RPC response, extract the `result.content[0].text` field, and map it to the existing `SearchResponse` / `ExtractedContent` types. The exact text format of `webSearchPrime` and `webReader` responses needs to be verified by testing against the live MCP endpoints. Implementation should include a parsing layer that can be adjusted once we see the actual response structure.

### 2. Modify `gemini-search.ts`

Add `"zai"` to the `SearchProvider` type union:

```typescript
export type SearchProvider = "auto" | "perplexity" | "gemini" | "exa" | "zai";
```

**In `search()` function:**
- Add explicit `provider === "zai"` branch that calls `searchWithZai()`
- Add z.ai to the auto fallback chain: **Exa → zai → Perplexity → Gemini**

**In `getSearchConfig()`:**
- Accept `"zai"` as a valid provider value in config

**API key context:** The `search()` function currently doesn't take a model registry parameter. We need to thread the model registry (or a pre-resolved API key) through so `searchWithZai()` can authenticate.

**Approach:** Add an optional `zaiApiKey?: string` field to `FullSearchOptions`. The caller (in `index.ts`) resolves the key once before starting searches and passes it down. If the key is not provided and z.ai is selected, `searchWithZai()` attempts its own resolution (env var, config file).

### 3. Modify `extract.ts`

Add z.ai webReader as a fallback content extractor.

**When standard extraction produces low-quality results** (content < `MIN_USEFUL_CONTENT` characters) or fails with a non-recoverable error, attempt `readWithZai()` as a fallback before returning the low-quality result.

**Conditions for using webReader fallback:**
- z.ai API key is available (resolved via same mechanism)
- Primary extraction failed or produced < `MIN_USEFUL_CONTENT` content
- URL is not a special type already handled (YouTube, PDF, GitHub, video)

**Priority order for content extraction:**
1. Direct fetch + Readability (existing)
2. Gemini URL context (existing, if API key available)
3. z.ai webReader (new)
4. Gemini Web (existing, if browser cookies available)

### 4. Modify `index.ts`

**Tool parameter schema:**
Add `"zai"` to the `provider` string enum:
```typescript
provider: StringEnum(["auto", "perplexity", "gemini", "exa", "zai"], ...)
```

**Provider availability:**
Add `zai: boolean` to `ProviderAvailability` interface.

**`getProviderAvailability()`:**
Add z.ai check:
```typescript
zai: isZaiAvailable(ctx?.modelRegistry),
```

Note: `getProviderAvailability()` is called before searches start. It needs access to the model registry. Currently it doesn't take a context parameter — we need to thread the registry through.

**`resolveProvider()`:**
Add z.ai to the auto fallback logic:
```
auto → exa (if available) → zai (if available) → perplexity → gemini
```

**Tool description:**
Update to mention z.ai as a provider option.

**Curator:**
The curator UI shows available providers. z.ai should appear when available.

### 5. API Key Resolution Strategy

**`resolveZaiApiKey(modelRegistry?)` in `zai.ts`:**

1. If `modelRegistry` is provided:
   - Get available models: `modelRegistry.getAvailable()`
   - Find any model with `provider === "zai"`
   - Call `modelRegistry.getApiKeyAndHeaders(model)` to get the API key
   - Return the key if found
2. Check `~/.pi/web-search.json` for `zaiApiKey` field
3. Check `ZAI_API_KEY` environment variable
4. Return null if no key found

**Key caching:** Cache the resolved key for the session (similar to how other providers cache their config). Invalidate on session change.

## Auto Fallback Order

The new auto provider fallback chain:

1. **Exa** — direct API (if key configured) or free MCP (no key needed)
2. **z.ai** — free with GLM Coding Plan, no extra key if z.ai provider configured
3. **Perplexity** — requires separate API key
4. **Gemini** — requires API key or browser cookies

**Rationale:** z.ai is placed early because GLM Coding Plan users already have credits and no additional configuration is needed. Exa MCP remains first since it's completely free with no authentication.

## Error Handling

- z.ai MCP returns standard JSON-RPC errors — handle `result.isError` and `error` fields
- HTTP errors (rate limiting, auth failures) surface as provider-specific errors
- If z.ai fails during auto fallback, proceed to next provider (same pattern as existing providers)
- If z.ai is explicitly selected and fails, return the error (same as other explicit provider selections)

## What's NOT in scope

- No quota tracking (user has this in their status line already)
- No refactoring of `gemini-search.ts` naming (deferred)
- No changes to the curator UI beyond showing z.ai as an available provider
- No changes to `code_search.ts` (uses Exa MCP, separate concern)

## Files Changed

| File | Change |
|------|--------|
| `zai.ts` (new) | z.ai MCP client: search, reader, key resolution |
| `gemini-search.ts` | Add `"zai"` provider type, routing, auto fallback |
| `extract.ts` | Add z.ai webReader as fallback content extractor |
| `index.ts` | Add z.ai to tool params, availability, provider resolution |
