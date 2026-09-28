# Stella

An AI chat plugin for [Obsidian](https://obsidian.md) with multi-provider LLM support, MCP integration, and deep vault context.

![Obsidian](https://img.shields.io/badge/Obsidian-v0.15.0+-7C3AED?logo=obsidian&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

### Multi-Provider LLM Support

Talk to any major LLM provider from inside your vault:

| Provider | Local | Notes |
|----------|-------|-------|
| **Anthropic** | No | Claude models (default) |
| **OpenAI** | No | GPT models |
| **Google** | No | Gemini models, native MCP support |
| **Ollama** | Yes | Any Ollama-hosted model |
| **LM Studio** | Yes | Any GGUF model |
| **OpenClaw** | Yes | WebSocket gateway for local agent models |
| **Custom** | Varies | Any OpenAI-compatible endpoint |

All providers support streaming responses and real-time model fetching.

### MCP (Model Context Protocol) Integration

Connect to MCP servers to extend what Stella can do:

- Browse and connect to MCP servers via `/mcp`
- Execute tools, load prompts, and browse resources
- Auto-discovery of available servers
- Server status indicators in the header

### Vault Integration

Your notes are first-class citizens in Stella conversations:

- **`@` mentions** — Type `@` in the input to search and attach notes as context
- **`[[Wiki links]]`** — Click to add as context, Ctrl+click to open the note
- Visual indicators show what context is currently attached

### System Prompts

Define who the LLM is. Load persona and behavioral prompts from `.md` files in a configurable vault folder.

```
/sys         → pick and load a system prompt
/sysclear    → remove the active system prompt
```

### Mental Models

Define *how* the LLM thinks. Mental models are reasoning frameworks injected with an explicit instruction for the LLM to actively apply them as an analytical lens — distinct from the system prompt's identity/persona.

```
/model       → pick and load a mental model
/modelclear  → remove the active mental model
```

Both can be active simultaneously. The system prompt shapes *who* the LLM is; the mental model shapes *how* it thinks.

### Conversation Management

- Multiple conversation threads with persistent history
- Smart auto-save (only persists conversations with messages or custom names)
- Auto-cleanup of empty/unnamed conversations
- Rename, delete, and browse history

### Chat Interface

- Clean sidebar UI with streaming markdown rendering
- Code block syntax highlighting, headers, lists, tables
- Copy button on assistant messages
- Customizable background image with opacity control
- Auto-hide header on scroll
- Optional token count display
- Loading animation with timer during API calls

---

## Installation

### Manual Install

1. Download the [latest release](https://github.com/poweredbypugs/Stella/releases)
2. Extract `main.js`, `manifest.json`, and `styles.css` into your vault at:
   ```
   .obsidian/plugins/Stella/
   ```
3. Restart Obsidian
4. Enable **Stella** in Settings → Community Plugins

### From Source

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/poweredbypugs/Stella.git
cd Stella
```

---

## Getting Started

1. Open **Settings → Stella**
2. Select your LLM provider
3. Enter your API key (not needed for local providers)
4. (Optional) Configure paths for system prompts and mental models folders
5. Open Stella from the ribbon icon or the command palette: **Open Stella Chat**

---

## Commands

All commands are typed directly into the chat input. Type `/help` to see the full list.

### Context

| Command | Description |
|---------|-------------|
| `/sys` | Load a system prompt from file |
| `/sysclear` | Clear the active system prompt |
| `/model` | Load a mental model from file |
| `/modelclear` | Clear the active mental model |
| `/mcp` | Open MCP server selector (tools, prompts, resources) |
| `/mcpclear` | Disconnect all MCP servers |
| `/clear` | Clear all context and start a fresh conversation |

### Conversations

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation |
| `/del` | Delete the current conversation |
| `/name` | Rename the current conversation |
| `/history` | Browse conversation history |

### Interface

| Command | Description |
|---------|-------------|
| `/settings` | Open plugin settings |
| `/hide` | Toggle header visibility |
| `/help` | Show all available commands |

### Special Input

| Input | Description |
|-------|-------------|
| `@` | Search and attach a vault note as context |
| `[[Note Name]]` | Click to add as context, Ctrl+click to open |

---

## Configuration

### API Settings

| Setting | Description |
|---------|-------------|
| Provider | Active LLM provider |
| API Key | Key for your selected cloud provider |
| Base URL | Server URL for local providers (Ollama, LM Studio) |
| Custom Endpoint | URL for any OpenAI-compatible API |

### Model Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Model | — | Selected model (fetched from provider) |
| Max Tokens | 4000 | Maximum response length |
| Temperature | 0.7 | Response randomness (0 = deterministic, 1 = creative) |

### UI Settings

| Setting | Description |
|---------|-------------|
| Background Image | Custom background image path |
| Background Mode | Centered or cover display |
| Background Opacity | Transparency level (0–1) |
| Auto-Hide Header | Fade header on scroll |
| Show Token Count | Display token usage per message |

### Paths

| Setting | Description |
|---------|-------------|
| System Prompts Path | Vault folder containing `.md` system prompt files |
| Mental Models Path | Vault folder containing `.md` mental model files |

### MCP

| Setting | Description |
|---------|-------------|
| Enable MCP | Toggle MCP functionality |
| MCP Servers | Configured server list |
| Auto-Discovery | Automatically discover available MCP servers |

---

## How It Works

Stella runs as an Obsidian sidebar view. When you send a message, it:

1. Composes a system message from your active system prompt + mental model + attached note context
2. Sends the full conversation to your selected LLM provider
3. Streams the response back with real-time markdown rendering
4. If MCP tools are available and the LLM invokes one, Stella executes the tool call and feeds the result back

All conversation data is stored locally in the plugin's `data.json` file within your vault. API keys are stored in Obsidian's plugin settings — nothing is sent anywhere except to the LLM provider you configure.

---

## Development

Stella is developed in a separate `Stella-dev/` folder and deployed to this production folder.

### Building from Source

```bash
cd Stella-dev
npm install
npm run build      # TypeScript check + esbuild bundle
npm run deploy     # Build + copy main.js to Stella/
```

### Project Structure (Development)

```
Stella-dev/
├── main.ts                  # Plugin entry point
├── src/
│   ├── types/               # TypeScript interfaces
│   ├── services/            # Cache, logger, MCP client
│   ├── providers/           # LLM provider implementations
│   └── views/modals/        # Modal UI components
├── styles.css               # Plugin styles
├── manifest.json            # Plugin manifest
├── esbuild.config.mjs       # Build configuration
└── package.json
```

### Provider Architecture

Stella uses a factory pattern for LLM providers. Each provider implements a common interface, and `getProvider()` returns the appropriate implementation based on settings. All providers receive a unified `ProviderContext` containing the system message, conversation history, and streaming callbacks.

---

## License

MIT

## Author

[PoweredbyPugs](https://github.com/poweredbypugs)
