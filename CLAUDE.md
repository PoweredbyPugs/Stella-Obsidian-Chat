# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stella is an Obsidian plugin providing an AI chat interface with multi-provider LLM support, note context integration, and MCP (Model Context Protocol) integration. The project has completed a major refactoring from a monolithic architecture to a modular structure.

## Build Commands

```bash
# Development mode (watch mode with sourcemaps)
npm run dev

# Production build (TypeScript check + bundle)
npm run build

# Deploy to production folder (build + copy to Stella/)
npm run deploy

# Version bump (updates manifest.json and versions.json)
npm run version
```

## Development Workflow

### Folder Structure
- **Stella-dev/** (vault) - Test copy (plugin ID: `stella-dev`, name "Stella (dev)"). Every build writes `main.js` here, plus a `manifest.json` derived from the repo's with the id/name swapped, plus `styles.css`.
- **Stella/** (vault) - Live copy (plugin ID: `stella`), synced to other devices via Obsidian Sync. Only `npm run deploy` writes here (`main.js`, `manifest.json`, `styles.css`). Never hand-edit it.

Both folders can coexist in Obsidian. Changes are developed in Stella-dev and deployed to Stella using `npm run deploy`.

### Testing Changes
1. Use `npm run dev` for development with auto-rebuild
2. Reload the plugin in Obsidian developer tools (Ctrl+Shift+I → Console → `app.plugins.disablePlugin('stella-dev'); app.plugins.enablePlugin('stella-dev')`)
3. When ready for production: `npm run deploy`

## Current Status: ✅ MODULAR REFACTORING COMPLETE

### ✅ Recently Completed (January 2026)

#### Phase 1-3: Module Extraction
- Extracted TypeScript interfaces to `src/types/`
- Extracted services (cache, logger, MCP client) to `src/services/`
- Extracted LLM providers to `src/providers/`
- Extracted modal components to `src/views/modals/`

#### Phase 4: Modal Integration
- Integrated `ConversationHistoryModal` replacing ~380 lines
- Integrated `createSystemPromptModal` replacing ~291 lines
- Integrated `NoteSelectorModal` replacing ~225 lines
- Integrated `createMentalModelModal` replacing ~243 lines

#### Phase 5: Provider Integration
- Integrated unified provider system with `getProvider()` factory
- Created `buildProviderContext()` helper for LLM calls
- Created `buildMCPContext()` helper for Google's MCP support
- Unified streaming via `streamLLM()` method

#### Conversation Management Enhancement
- **Smart Save**: Only saves conversations that are named (custom title) or have messages
- **Auto-Cleanup**: Empty/unnamed conversations automatically deleted on startup and when creating new chats
- **Date Detection**: `isDefaultDateTitle()` checks for YYYY-MM-DD pattern (auto-generated titles)

## Architecture Overview

### Modular File Structure

```
Stella-dev/
├── main.ts                    # Main plugin entry (~5,400 lines, down from 7,455)
├── src/
│   ├── types/                 # TypeScript interfaces
│   │   ├── index.ts           # Main type exports
│   │   ├── settings.ts        # StellaSettings interface
│   │   ├── conversation.ts    # Conversation, Message types
│   │   ├── mcp.ts             # MCP-related types
│   │   └── provider.ts        # Provider context types
│   │
│   ├── services/              # Core services
│   │   ├── index.ts           # Service exports
│   │   ├── cache.ts           # CacheService for model caching
│   │   ├── logger.ts          # Logger utility
│   │   └── mcp/               # MCP client implementation
│   │       ├── index.ts
│   │       └── client.ts      # MCPClient class
│   │
│   ├── providers/             # LLM provider implementations
│   │   ├── index.ts           # Provider exports & factory
│   │   ├── base.ts            # Base provider interface
│   │   ├── anthropic.ts       # Anthropic Claude
│   │   ├── openai.ts          # OpenAI GPT
│   │   ├── google.ts          # Google Gemini
│   │   ├── ollama.ts          # Ollama local
│   │   ├── lmstudio.ts        # LM Studio local
│   │   ├── custom.ts          # Custom OpenAI-compatible
│   │   └── openclaw.ts        # OpenClaw (Robin) via WebSocket
│   │
│   └── views/                 # UI components
│       └── modals/            # Modal dialogs
│           ├── index.ts       # Modal exports
│           ├── conversation-history.ts
│           ├── system-prompt.ts
│           ├── mental-model.ts
│           └── note-selector.ts
│
├── styles.css                 # Plugin styles
├── manifest.json              # Plugin manifest (ID: stella — the real plugin)
├── package.json               # Dependencies & scripts
├── esbuild.config.mjs         # Build configuration
└── CLAUDE.md                  # This file
```

### Core Classes

- **`StellaPlugin`** (main.ts): Main plugin class handling lifecycle, view registration, and settings management
- **`StellaChatView`** (main.ts): Chat interface view extending Obsidian's `ItemView` for the right sidebar
- **`StellaSettingTab`** (main.ts): Settings interface extending `PluginSettingTab` for provider/API configuration

### Key Architecture Patterns

- **Provider Factory**: `getProvider()` returns appropriate provider based on settings
- **Unified Context**: `buildProviderContext()` creates consistent context for all providers
- **MCP Integration**: Full MCP client with tool execution support
- **Modal Components**: Extracted, reusable modal classes for file selection and history

## Conversation Save Behavior

Conversations are only persisted if they meet one of these criteria:
1. **Has custom name**: Title is NOT a default date format (YYYY-MM-DD)
2. **Has messages**: The messages array is not empty

```typescript
// Check if conversation title is a default date format
private isDefaultDateTitle(title: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(title);
}

// Check if a conversation is worth saving
private isWorthSaving(conversation: Conversation): boolean {
    const hasCustomName = !this.isDefaultDateTitle(conversation.title);
    const hasMessages = conversation.messages && conversation.messages.length > 0;
    return hasCustomName || hasMessages;
}
```

Empty/unnamed conversations are automatically cleaned up:
- When starting a new conversation
- When loading conversations on plugin startup

## Current Features

### ✅ Core Chat Functionality
- Multi-provider LLM support (Anthropic, OpenAI, Google, Ollama, LM Studio, Custom, OpenClaw)
- Real-time model fetching and selection
- Persistent conversation history with smart save behavior
- Markdown rendering for AI responses
- Copy last response functionality

### ✅ Advanced Features
- **System Prompts**: `/sys` command opens file browser for .md system prompts
- **Mental Models**: `/model` command opens file browser for .md mental model files. Mental models are injected into the system message with a labeled header (`## Active Mental Model: <name>`) and an explicit instruction telling the LLM to actively apply it as a reasoning lens, distinct from the system prompt identity/persona.
- **Wiki Link Resolution**: `[[Note Name]]` automatically becomes clickable links
- **Note Context**: "@" symbol opens quick switcher to add vault notes as context
- **MCP Integration**: Full MCP client with tool execution via `/mcp` command
- **Conversation Management**: Smart save, auto-cleanup, conversation switching

### ✅ User Experience
- **Keyboard Shortcuts**: Enter to send, "@" for notes, "/sys" for system prompts
- **Interactive Wiki Links**: Click `[[Note]]` to add to context, Ctrl+Click to open
- **Visual Indicators**: Note context, system prompt, mental model, MCP - all with hover tooltips
- **Clean Interface**: No placeholder text, neutral colors, proper spacing

## Available Commands

All commands are accessible via the chat input. Type `/help` to see this list in the chat.

### Context Management
- **`/help`** - Show all available commands
- **`/sys`** - Load system prompt from file
- **`/sysclear`** - Clear current system prompt
- **`/model`** - Load mental model from file
- **`/modelclear`** - Clear current mental model
- **`/mcp`** - Connect to MCP server
- **`/mcpclear`** - Clear MCP connections
- **`/clear`** - Clear all context and start new conversation

### Conversation Management
- **`/new`** - Start new conversation
- **`/del`** - Delete current conversation
- **`/history`** - Show conversation history
- **`/name`** - Rename current conversation

### Interface
- **`/settings`** - Open plugin settings
- **`/hide`** - Toggle header visibility

### Special Input
- **`@`** - Add note context (opens quick switcher)
- **`[[Note]]`** - Interactive wiki links (click to add context, Ctrl+click to open)

## Provider System

### Provider Factory Pattern
```typescript
// Get provider instance based on settings
const provider = getProvider(settings.provider);

// Build context for LLM call
const context: ProviderContext = {
    settings,
    systemMessage: buildSystemMessage(),
    messages: conversation.messages,
    onToken: (token) => updateUI(token),
    signal: abortController.signal
};

// Make the call
const response = await provider.chat(context);
```

### Supported Providers
| Provider | Models | Local | MCP Support |
|----------|--------|-------|-------------|
| Anthropic | Claude 3.5, Claude 3 | No | Via tools |
| OpenAI | GPT-4, GPT-3.5 | No | Via tools |
| Google | Gemini Pro, Flash | No | Native |
| Ollama | Llama, Mistral, etc. | Yes | Via tools |
| LM Studio | Any GGUF model | Yes | Via tools |
| Custom | OpenAI-compatible | Varies | Via tools |
| OpenClaw | Robin (via Gateway) | Yes | Native (WebSocket) |

## MCP Integration

### Connecting to MCP Servers
```
/mcp
```
Opens a modal to configure and connect to MCP servers.

### MCP Architecture
- **MCPClient** (`src/services/mcp/client.ts`): Handles server connections via stdio
- **Tool Execution**: Automatic tool calls during LLM conversations
- **Windows Support**: Proper .cmd handling for npm/npx servers

## Settings Persistence
- Settings stored in `data.json` via Obsidian's `loadData()`/`saveData()`
- Provider configuration, API keys, model selection
- System prompt and mental models directory paths
- Conversation history (only worth-saving conversations)

## System Message Architecture

`buildSystemMessage()` (main.ts) constructs the system message from three components:

1. **System Prompt** — identity, persona, behavioral constraints (injected as-is)
2. **Mental Model** — reasoning framework, injected with a labeled header and instruction to actively apply it as an analytical lens
3. **Context Notes** — reference notes from the vault

All providers receive the same composed system message via `buildProviderContext()`. Each provider passes it to its API in the appropriate way:
- **Anthropic**: `system` parameter (dedicated field)
- **Google**: `systemInstruction` (dedicated field)
- **OpenAI/LM Studio/Custom**: `{ role: 'system' }` message in the messages array
- **Ollama**: Prepended to the prompt string
- **OpenClaw**: Via WebSocket session context

## Session Notes

- **Last Updated**: February 25, 2026
- **Status**: Modular refactoring complete, all features working
- **Recent Work**:
  - Added OpenClaw (Robin) provider with WebSocket gateway support
  - Differentiated system prompt vs mental model in `buildSystemMessage()` — mental models now injected with labeled header and active reasoning instruction
  - Switched system prompt and mental model file loading to Obsidian vault API (`vault.cachedRead`) instead of Node.js `fs`
  - Fixed `/name` command to work immediately on fresh conversations (auto-creates backing conversation)
  - Conversation init now calls `startNewConversation()` instead of just setting a date title
- **Plugin Size**: main.ts ~5,900 lines
- **Known Issues**: None currently blocking
