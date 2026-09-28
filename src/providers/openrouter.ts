import { requestUrl } from 'obsidian';
import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

/**
 * OpenRouter provider — one API key, hundreds of models from many vendors,
 * all behind an OpenAI-compatible chat completions endpoint.
 *
 * OpenRouter answers CORS preflights for any origin, so plain `fetch` works
 * from Obsidian (and is needed for streaming). Model ids look like
 * `anthropic/claude-sonnet-5` or `openai/gpt-5`.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Optional attribution headers — OpenRouter shows the app name in its
// dashboard and activity log.
const ATTRIBUTION_HEADERS = {
    'HTTP-Referer': 'https://github.com/PoweredbyPugs/Stella-Obsidian-Chat',
    'X-Title': 'Stella',
};

/** List every model id OpenRouter offers, alphabetically. No key needed. */
export async function listOpenRouterModels(): Promise<string[]> {
    const response = await requestUrl({ url: `${OPENROUTER_BASE}/models`, throw: false });
    if (response.status !== 200) {
        throw new Error(`OpenRouter models error: HTTP ${response.status}`);
    }
    const ids: string[] = (response.json?.data || [])
        .map((m: any) => m?.id)
        .filter((id: any) => typeof id === 'string' && id.length > 0);
    return ids.sort((a, b) => a.localeCompare(b));
}

export class OpenRouterProvider implements LLMProvider {
    name = 'openrouter';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.openrouterApiKey;
    }

    private buildRequest(settings: StellaSettings, messages: ProviderContext['messages'], stream: boolean): RequestInit {
        if (!settings.openrouterApiKey) {
            throw new Error('Please set your OpenRouter API key in settings');
        }
        if (!settings.model) {
            throw new Error('Please pick an OpenRouter model in settings');
        }
        return {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openrouterApiKey}`,
                ...ATTRIBUTION_HEADERS,
            },
            body: JSON.stringify({
                model: settings.model,
                messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature,
                stream,
            }),
        };
    }

    private async errorFrom(response: Response): Promise<Error> {
        const text = await response.text();
        let detail = text;
        try {
            detail = JSON.parse(text)?.error?.message || text;
        } catch { /* not JSON */ }
        return new Error(`OpenRouter error (${response.status}): ${detail}`);
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;
        const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, this.buildRequest(settings, messages, false));
        if (!response.ok) throw await this.errorFrom(response);

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;
        const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, this.buildRequest(settings, messages, true));
        if (!response.ok) throw await this.errorFrom(response);

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        // SSE lines can be split across network chunks, so keep the
        // unfinished tail and only parse complete lines.
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    // Lines starting with ':' are keep-alive comments
                    // (": OPENROUTER PROCESSING") and are skipped here.
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        await callbacks.onComplete();
                        return;
                    }

                    let parsed: any;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        continue;
                    }
                    // Errors after the stream starts arrive as a data frame.
                    if (parsed.error) {
                        throw new Error(`OpenRouter error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                    }
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) callbacks.onContent(content);
                }
            }
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
