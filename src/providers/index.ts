// Export types
export * from './types';

// Export providers
export { OpenAIProvider } from './openai';
export { AnthropicProvider } from './anthropic';
export { GoogleProvider } from './google';
export { OllamaProvider } from './ollama';
export { LMStudioProvider } from './lmstudio';
export { CustomAPIProvider } from './custom';
export { OpenClawProvider } from './openclaw';
export { HermesProvider, HERMES_FALLBACK_MODEL, listHermesModels } from './hermes';
export { OpenRouterProvider, listOpenRouterModels } from './openrouter';

// Import for factory
import { LLMProvider } from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';
import { OllamaProvider } from './ollama';
import { LMStudioProvider } from './lmstudio';
import { CustomAPIProvider } from './custom';
import { OpenClawProvider } from './openclaw';
import { HermesProvider } from './hermes';
import { OpenRouterProvider } from './openrouter';

// Provider registry
const providers: Record<string, LLMProvider> = {
    openai: new OpenAIProvider(),
    anthropic: new AnthropicProvider(),
    google: new GoogleProvider(),
    ollama: new OllamaProvider(),
    lmstudio: new LMStudioProvider(),
    custom: new CustomAPIProvider(),
    openclaw: new OpenClawProvider(),
    hermes: new HermesProvider(),
    openrouter: new OpenRouterProvider(),
};

// Factory function to get provider by name
export function getProvider(name: string): LLMProvider | undefined {
    return providers[name];
}

// Get all provider names
export function getProviderNames(): string[] {
    return Object.keys(providers);
}
