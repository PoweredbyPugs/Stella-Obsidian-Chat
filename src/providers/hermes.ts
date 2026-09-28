import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

/**
 * Hermes Agent Provider (Nous Research)
 *
 * Connects to a running Hermes Agent dashboard server and chats through its
 * WebSocket endpoint. Unlike raw LLM providers, this talks to a full agent:
 * Hermes brings its own model routing, tools, skills, and memory — Stella
 * just delivers the user's message and streams the reply.
 *
 * Server side: `pip install 'hermes-agent[web,pty]'` then `hermes dashboard`
 * (default http://127.0.0.1:9119). Loopback binds require no auth, which is
 * the supported setup here; remote dashboards use session-cookie auth that a
 * plain WebSocket from Obsidian can't perform.
 *
 * Protocol (JSON-RPC 2.0 over WS at /api/ws):
 * - client → server: { jsonrpc, id, method: "session.create", params: { source } }
 *                    → result: { session_id }
 *                    { jsonrpc, id, method: "prompt.submit", params: { session_id, text } }
 * - server → client: responses matched by id ({ id, result } / { id, error })
 *                    notifications { method: "event", params: { session_id, type, payload } }
 *                    where type is "message.delta" ({ text }), "message.complete"
 *                    ({ text? }) or "error" ({ message?/error? })
 */

interface HermesFrame {
    id?: string;
    result?: any;
    error?: { message?: string } | any;
    method?: string;
    params?: {
        session_id?: string;
        type?: string;
        payload?: { text?: string; message?: string; error?: string };
    };
}

// Sentinel model id shown in Stella's model dropdown. The session protocol
// doesn't take a model, so the agent always uses its configured one.
export const HERMES_DEFAULT_MODEL = 'hermes:agent';

export class HermesProvider implements LLMProvider {
    name = 'hermes';

    private ws: WebSocket | null = null;
    private connectedUrl = '';
    private sessionId: string | null = null;
    private reqCounter = 0;

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.hermesUrl;
    }

    private getWsUrl(settings: StellaSettings): string {
        let url = (settings.hermesUrl || '').trim();
        if (!url) throw new Error('Hermes dashboard URL is not set');
        url = url.replace(/\/+$/, '');
        if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
        url = url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        // Accept either a bare host:port or a URL already pointing at /api/ws
        if (!url.endsWith('/api/ws')) url += '/api/ws';
        return url;
    }

    private async connect(settings: StellaSettings): Promise<WebSocket> {
        const wsUrl = this.getWsUrl(settings);
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connectedUrl === wsUrl) {
            return this.ws;
        }
        this.disconnect();

        return new Promise((resolve, reject) => {
            let ws: WebSocket;
            try {
                ws = new WebSocket(wsUrl);
            } catch (err) {
                reject(new Error(`Failed to create WebSocket: ${err}`));
                return;
            }

            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error(
                    'Hermes connection timeout (10s). Is the dashboard running? ' +
                    'Start it with `hermes dashboard` (requires the [web,pty] extras).'
                ));
            }, 10000);

            ws.onopen = () => {
                clearTimeout(timeout);
                this.ws = ws;
                this.connectedUrl = wsUrl;
                this.sessionId = null;
                console.log('Hermes: connected to', wsUrl);
                resolve(ws);
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(
                    `Could not connect to Hermes at ${wsUrl}. Check that ` +
                    '`hermes dashboard` is running and the URL in settings matches.'
                ));
            };

            ws.onclose = () => {
                if (this.ws === ws) {
                    this.ws = null;
                    this.connectedUrl = '';
                    this.sessionId = null;
                }
            };
        });
    }

    /** Send a JSON-RPC request and resolve with the matching response's result. */
    private request(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Not connected to Hermes'));
        }
        const id = `stella-${Date.now()}-${++this.reqCounter}`;

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                ws.removeEventListener('message', onMessage);
                ws.removeEventListener('close', onClose);
            };

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Hermes request timed out: ${method}`));
            }, timeoutMs);

            const onClose = () => {
                cleanup();
                reject(new Error('Hermes connection closed'));
            };

            const onMessage = (event: MessageEvent) => {
                let ev: HermesFrame;
                try {
                    ev = JSON.parse(String(event.data));
                } catch {
                    return;
                }
                if (ev.id !== id) return;
                cleanup();
                if (ev.error) {
                    reject(new Error(ev.error.message || JSON.stringify(ev.error)));
                } else {
                    resolve(ev.result || {});
                }
            };

            ws.addEventListener('message', onMessage);
            ws.addEventListener('close', onClose);

            try {
                ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (err) {
                cleanup();
                reject(new Error(`Failed to send Hermes request: ${err}`));
            }
        });
    }

    /** Connect if needed and reuse one Hermes session per connection. */
    private async ensureSession(settings: StellaSettings): Promise<string> {
        await this.connect(settings);
        if (this.sessionId) return this.sessionId;
        const result = await this.request('session.create', { source: 'obsidian-stella' });
        this.sessionId = result.session_id;
        if (!this.sessionId) throw new Error('Hermes did not return a session_id');
        return this.sessionId;
    }

    async call(context: ProviderContext): Promise<string> {
        let fullResponse = '';
        await this.stream(context, {
            onContent: (text) => { fullResponse += text; },
            onComplete: async () => {}
        });
        return fullResponse;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;

        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastMessage.role !== 'user') {
            throw new Error('No user message to send');
        }

        // Hermes holds its own conversation state server-side, so only the
        // new user message is delivered — not the whole Stella history.
        const sid = await this.ensureSession(settings);
        const ws = this.ws!;

        let accumulated = '';

        await new Promise<void>(async (resolve, reject) => {
            const cleanup = () => {
                ws.removeEventListener('message', onMessage);
                ws.removeEventListener('close', onClose);
                clearTimeout(safetyTimeout);
            };

            // Safety net — if the run never completes, don't hang the chat.
            const safetyTimeout = setTimeout(() => {
                cleanup();
                if (accumulated.length > 0) resolve();
                else reject(new Error('Hermes response timed out'));
            }, 300000); // 5 minutes

            const onClose = () => {
                cleanup();
                if (accumulated.length > 0) {
                    // Connection dropped mid-reply: keep what we have.
                    resolve();
                } else {
                    reject(new Error('Hermes connection closed before a reply arrived'));
                }
            };

            const onMessage = (event: MessageEvent) => {
                let ev: HermesFrame;
                try {
                    ev = JSON.parse(String(event.data));
                } catch {
                    return;
                }

                // Only session events for this chat; RPC responses are
                // handled by request().
                if (ev.method !== 'event' || !ev.params || ev.params.session_id !== sid) return;
                const type = ev.params.type;
                const payload = ev.params.payload || {};

                switch (type) {
                    case 'message.delta': {
                        if (typeof payload.text === 'string' && payload.text.length > 0) {
                            accumulated += payload.text;
                            callbacks.onContent(payload.text);
                        }
                        break;
                    }
                    case 'message.complete': {
                        // The final frame may carry the full text; emit any
                        // tail the deltas didn't cover.
                        const finalText = typeof payload.text === 'string' ? payload.text : accumulated;
                        if (finalText && finalText.length > accumulated.length && finalText.startsWith(accumulated)) {
                            const chunk = finalText.slice(accumulated.length);
                            accumulated = finalText;
                            callbacks.onContent(chunk);
                        }
                        cleanup();
                        resolve();
                        break;
                    }
                    case 'error': {
                        const detail = payload.message || payload.error || 'Unknown Hermes error';
                        cleanup();
                        if (accumulated.length > 0) {
                            callbacks.onContent(`\n\nError: ${detail}`);
                            resolve();
                        } else {
                            reject(new Error(`Hermes error: ${detail}`));
                        }
                        break;
                    }
                    default:
                        // Ignore other event types (status, pings, etc.)
                        break;
                }
            };

            ws.addEventListener('message', onMessage);
            ws.addEventListener('close', onClose);

            try {
                await this.request('prompt.submit', { session_id: sid, text: lastMessage.content }, 30000);
            } catch (err) {
                cleanup();
                reject(err);
            }
        });

        await callbacks.onComplete();
    }

    disconnect(): void {
        if (this.ws) {
            try { this.ws.close(); } catch { /* already closing */ }
            this.ws = null;
        }
        this.connectedUrl = '';
        this.sessionId = null;
    }
}
