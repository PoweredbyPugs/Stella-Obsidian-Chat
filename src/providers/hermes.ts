import { requestUrl } from 'obsidian';
import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

/**
 * Hermes Agent Provider (Nous Research)
 *
 * Talks to the Hermes gateway's OpenAI-compatible API server (the
 * "api_server" platform, default port 8642), authenticated with the
 * gateway's API_SERVER_KEY. Unlike raw LLM providers, this is a full agent:
 * Hermes brings its own model routing, tools, skills, and memory — Stella
 * delivers the conversation and shows the reply.
 *
 * Why not the dashboard (port 9119)? Its /api/ws socket rejects any Host
 * other than the one it's bound to, requires a per-launch session token
 * injected into its own web page, and checks Origin — none of which an
 * outside app can satisfy, so it only ever worked from the same machine.
 *
 * Requests go through Obsidian's `requestUrl`, which skips CORS (the API
 * server only answers origins listed in API_SERVER_CORS_ORIGINS). The
 * trade-off: no streaming, so the reply arrives whole when the run ends.
 */

// Model id Hermes' /v1/models reports; used when the list can't be fetched.
export const HERMES_FALLBACK_MODEL = 'hermes-agent';

/** Normalize the settings URL to the API base, e.g. http://host:8642/v1 */
export function hermesApiBase(settings: StellaSettings): string {
    let url = (settings.hermesUrl || '').trim();
    if (!url) throw new Error('Hermes API URL is not set');
    if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
    url = url.replace(/\/+$/, '');
    // Accept a bare host:port, a /v1 base, or a full endpoint URL.
    url = url.replace(/\/v1(\/.*)?$/, '');
    return url + '/v1';
}

function explainHttpError(status: number, body: any): Error {
    if (status === 401) {
        return new Error('Hermes rejected the API key. Copy API_SERVER_KEY from ~/.hermes/.env on the Hermes machine into Stella\'s settings.');
    }
    const detail = body?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
    return new Error(`Hermes error (${status}): ${detail}`);
}

async function hermesRequest(settings: StellaSettings, path: string, init: { method?: string; body?: string } = {}): Promise<any> {
    const url = hermesApiBase(settings) + path;
    let response;
    try {
        response = await requestUrl({
            url,
            method: init.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${(settings.hermesApiKey || '').trim()}`,
            },
            body: init.body,
            throw: false,
        });
    } catch (err) {
        throw new Error(`Could not reach Hermes at ${url}. Is the Hermes gateway running with its API server enabled? (${err})`);
    }
    let body: any;
    try {
        body = response.json;
    } catch {
        body = response.text;
    }
    if (response.status < 200 || response.status >= 300) {
        throw explainHttpError(response.status, body);
    }
    return body;
}

/** Model ids the Hermes API server advertises (normally just one). */
export async function listHermesModels(settings: StellaSettings): Promise<string[]> {
    if (!settings.hermesUrl || !settings.hermesApiKey) return [];
    const body = await hermesRequest(settings, '/models');
    return (body?.data || [])
        .map((m: any) => m?.id)
        .filter((id: any) => typeof id === 'string' && id.length > 0);
}

export class HermesProvider implements LLMProvider {
    name = 'hermes';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.hermesUrl && !!settings.hermesApiKey;
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;

        // The chat completions endpoint is stateless: send the whole Stella
        // conversation (including the system message) every turn.
        const body = await hermesRequest(settings, '/chat/completions', {
            method: 'POST',
            body: JSON.stringify({
                model: settings.model || HERMES_FALLBACK_MODEL,
                messages,
                stream: false,
            }),
        });
        return body?.choices?.[0]?.message?.content || '';
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        // requestUrl can't stream, so deliver the finished reply in one go.
        const text = await this.call(context);
        if (text) callbacks.onContent(text);
        await callbacks.onComplete();
    }
}
