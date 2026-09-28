# Stella - Obsidian AI Chat Plugin

**Version:** 0.1.1
**Author:** PoweredbyPugs
**Minimum Obsidian Version:** 0.15.0

## Overview

Stella is an advanced AI chat plugin for Obsidian that provides seamless LLM integration with support for multiple providers, MCP (Model Context Protocol) servers, and deep integration with your Obsidian vault.

## Features

### Multi-Provider LLM Support

Stella supports multiple AI providers out of the box:

- **Anthropic** (Claude models) - Default provider
- **OpenAI** (GPT models)
- **Google** (Gemini models)
- **Ollama** - Local models via `http://localhost:11434`
- **LM Studio** - Local models via `http://localhost:1234`
- **Custom API** - Any OpenAI-compatible endpoint

### MCP (Model Context Protocol) Integration

Full MCP support enables:
- Connecting to MCP servers for extended tool capabilities
- Auto-discovery of available MCP servers
- Tool calls and function execution through MCP
- Server management UI with connection status indicators
- **Resource browsing** - View and load MCP resources (e.g., natal charts, reference data)
- Resource content fetching and injection into chat context

### Conversation Management

- Multiple conversation threads
- Conversation history persistence
- Conversation naming and organization
- Pagination for long conversation lists
- Load older messages on demand

### System Prompts

- Load system prompts from markdown files in your vault
- Configure a dedicated folder for system prompt files
- Quick switching between different system prompts
- Visual indicator showing active system prompt

### Mental Models

- Load "mental models" (extended context/personas) from markdown files
- Separate configuration path from system prompts
- Visual indicator showing active mental model
- Commands: `/model` (load) and `/modelclear` (clear)

### Note Context Integration

- Add notes from your vault as context for conversations
- Search and select notes via modal interface
- Note content preview before adding
- Wiki-link rendering in chat messages (`[[Note Name]]`)
- Click wiki links to navigate to notes
- Visual indicator showing attached note context

### Chat Interface

- Clean, modern chat UI inspired by popular chat applications
- Streaming responses with real-time display
- Markdown rendering in messages (headers, code blocks, lists, etc.)
- Copy button on assistant messages
- Auto-scrolling to new messages
- Customizable background image with opacity control
- Auto-hide header option

### Additional Features

- **Token counting** - Optional display of token usage
- **Response caching** - Intelligent caching with configurable TTL
- **QuickAdd integration** - Custom commands for note creation
- **Loading animation** - Visual feedback during API calls with timer

## Architecture

### Core Components

```
StellaPlugin (main.ts)
├── CacheManager        - Response and data caching
├── FetchManager        - HTTP request handling
├── MCPManager          - MCP server connections and tool calls
├── StellaChatView      - Main chat interface (ItemView)
└── StellaSettingTab    - Plugin settings UI
```

### Key Classes

- **StellaPlugin**: Main plugin class extending Obsidian's Plugin
- **StellaChatView**: ItemView implementation for the chat interface
- **StellaSettingTab**: PluginSettingTab for configuration
- **CacheManager**: Handles caching with localStorage persistence
- **MCPManager**: Manages MCP server connections and messaging

### Data Storage

- **data.json**: Plugin settings and conversation data
- **localStorage**: Cache persistence (with `stella_cache_` prefix)

## Settings

### API Configuration

| Setting | Description |
|---------|-------------|
| `provider` | Active LLM provider |
| `openaiApiKey` | OpenAI API key |
| `anthropicApiKey` | Anthropic API key |
| `googleApiKey` | Google AI API key |
| `ollamaBaseUrl` | Ollama server URL |
| `lmStudioBaseUrl` | LM Studio server URL |
| `customApiUrl` | Custom API endpoint |
| `customApiKey` | Custom API key |

### Model Settings

| Setting | Description |
|---------|-------------|
| `model` | Selected model name |
| `maxTokens` | Maximum response tokens (default: 4000) |
| `temperature` | Response randomness (default: 0.7) |

### UI Settings

| Setting | Description |
|---------|-------------|
| `backgroundImage` | Custom background image path |
| `backgroundMode` | Background display mode (centered/cover) |
| `backgroundOpacity` | Background opacity (0-1) |
| `autoHideHeader` | Auto-hide header on scroll |
| `showTokenCount` | Display token usage |

### Path Settings

| Setting | Description |
|---------|-------------|
| `systemPromptsPath` | Folder containing system prompt files |
| `mentalModelsPath` | Folder containing mental model files |

### MCP Settings

| Setting | Description |
|---------|-------------|
| `mcpEnabled` | Enable MCP functionality |
| `mcpServers` | Configured MCP server list |
| `mcpAutoDiscovery` | Auto-discover MCP servers |

## Commands

| Command | Description |
|---------|-------------|
| Open Stella Chat | Opens the chat view in the sidebar |
| `/name` | Rename current conversation |
| `/new` | Start a new conversation |
| `/del` | Delete current conversation |
| `/history` | Show conversation history |
| `/sys` | Load a system prompt from file |
| `/sysclear` | Clear the current system prompt |
| `/model` | Load a mental model from file |
| `/modelclear` | Clear the current mental model |
| `/mcp` | Open MCP server selector (tools, prompts, resources) |
| `/mcpclear` | Clear active MCP connections |
| `/clear` | Clear all context |
| `/hide` | Toggle header visibility |
| `/settings` | Open plugin settings |
| `/help` | Show available commands |

## Development

### Build System

The plugin is bundled using **esbuild**. The `main.js` file is a generated bundle.

### Source Structure

```
Stella/
├── main.js          # Bundled plugin code
├── manifest.json    # Plugin manifest
├── styles.css       # Plugin styles
├── data.json        # User settings/data
└── PROJECT.md       # This file
```

### CSS Architecture

Styles follow BEM-like naming with `stella-` prefix:
- `.stella-mcp-chat-container` - Main container
- `.stella-message-*` - Message styling
- `.stella-*-indicator` - Status indicators
- `.stella-modal-*` - Modal components

## Roadmap

### Near-term
- [ ] File picker for settings paths (background image, loading image, system prompts folder, mental models folder)

### Future
- [ ] Semantic search integration
- [ ] Embedding-based note retrieval
- [ ] Conversation export/import
- [ ] Multi-modal support (images)
- [ ] Voice input/output
- [ ] Plugin API for extensions

## Changelog

### v0.1.1 (2026-01-22)
- Added MCP Resources support in the `/mcp` selector modal
- Resources now displayed alongside Tools and Prompts
- Click a resource to fetch and load its content into chat
- Added `refreshServerResources` method for on-demand resource discovery
- Fixed `/name` command not working in some cases

### v0.1.0
- Initial release with multi-provider LLM support
- MCP integration with tools and prompts
- Conversation management
- System prompts and mental models
- Note context integration
- Custom background and UI theming

## License

See repository for license information.

---

*Generated for Stella v0.1.1*
