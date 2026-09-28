// Conversation interface
export interface Message {
    role: string;
    content: string;
    timestamp: number;
}

export interface Conversation {
    id: string;
    title: string;
    messages: Message[];
    systemPrompt?: string;
    systemPromptFilename?: string;
    mentalModel?: string;
    mentalModelFilename?: string;
    mcpServers?: string[];
    createdAt: number;
    updatedAt: number;
}

// MCP (Model Context Protocol) interfaces
export interface MCPServer {
    id: string;
    name: string;
    transport: 'stdio' | 'http';
    endpoint?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    capabilities?: MCPCapabilities;
    connected: boolean;
}

export interface MCPServerTemplate {
    name: string;
    description: string;
    command: string;
    args: string[];
    envVariables: Array<{
        key: string;
        description: string;
        required: boolean;
        placeholder?: string;
    }>;
}

export interface MCPCapabilities {
    resources?: boolean;
    tools?: boolean;
    prompts?: boolean;
    sampling?: boolean;
}

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: any;
    serverId: string;
}

export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    serverId: string;
}

export interface MCPPrompt {
    name: string;
    description?: string;
    arguments?: any;
    serverId: string;
}

export interface MCPMessage {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: any;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

// Plugin settings interface
export interface StellaSettings {
    provider: string;
    openaiApiKey: string;
    anthropicApiKey: string;
    googleApiKey: string;
    ollamaBaseUrl: string;
    lmStudioBaseUrl: string;
    customApiUrl: string;
    customApiKey: string;
    openrouterApiKey: string;
    // Hermes Agent (Nous Research) dashboard URL — started with
    // `hermes dashboard`, default http://127.0.0.1:9119. Chat goes over
    // its /api/ws WebSocket. Points at the default profile's dashboard;
    // to target a different agent/profile, run that profile's dashboard
    // on another port and change this URL.
    hermesUrl: string;
    model: string;
    maxTokens: number;
    temperature: number;
    conversations: Conversation[];
    currentConversationId: string | null;
    systemPromptsPath: string;
    mentalModelsPath: string;
    backgroundImage: string;
    backgroundMode: 'centered' | 'fill' | 'stretch';
    backgroundOpacity: number;
    loadingGif: string;
    autoHideHeader: boolean;
    quickAddCommands: QuickAddCommand[];
    showTokenCount: boolean;
    // MCP Settings
    mcpEnabled: boolean;
    mcpServers: MCPServer[];
    mcpAutoDiscovery: boolean;
}

export interface QuickAddCommand {
    id: string;
    name: string;
    description: string;
}

export interface ContextNote {
    name: string;
    content: string;
}

export interface CommandDefinition {
    command: string;
    description: string;
}

// Default settings
export const DEFAULT_SETTINGS: StellaSettings = {
    provider: 'anthropic',
    openaiApiKey: '',
    anthropicApiKey: '',
    googleApiKey: '',
    ollamaBaseUrl: 'http://localhost:11434',
    lmStudioBaseUrl: 'http://localhost:1234',
    customApiUrl: '',
    customApiKey: '',
    openrouterApiKey: '',
    hermesUrl: 'http://127.0.0.1:9119',
    model: '',
    maxTokens: 4000,
    temperature: 0.7,
    conversations: [],
    currentConversationId: null,
    systemPromptsPath: '',
    mentalModelsPath: '',
    backgroundImage: '',
    backgroundMode: 'centered',
    backgroundOpacity: 0.5,
    loadingGif: '',
    autoHideHeader: false,
    quickAddCommands: [
        {
            id: 'seed',
            name: 'Seed',
            description: 'Create a seed note from selected text'
        }
    ],
    showTokenCount: false,
    mcpEnabled: false,
    mcpServers: [],
    mcpAutoDiscovery: true
};

// MCP Server Templates
export const MCP_SERVER_TEMPLATES: MCPServerTemplate[] = [
    {
        name: "File System",
        description: "Access and manage local files and directories",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        envVariables: []
    },
    {
        name: "GitHub",
        description: "Access GitHub repositories, issues, and code",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envVariables: [
            {
                key: "GITHUB_PERSONAL_ACCESS_TOKEN",
                description: "GitHub Personal Access Token",
                required: true,
                placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx"
            }
        ]
    },
    {
        name: "Brave Search",
        description: "Search the web using Brave Search API",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        envVariables: [
            {
                key: "BRAVE_API_KEY",
                description: "Brave Search API Key",
                required: true,
                placeholder: "Your Brave API key"
            }
        ]
    },
    {
        name: "Slack",
        description: "Interact with Slack workspaces and channels",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"],
        envVariables: [
            {
                key: "SLACK_BOT_TOKEN",
                description: "Slack Bot Token",
                required: true,
                placeholder: "xoxb-your-bot-token"
            }
        ]
    },
    {
        name: "PostgreSQL",
        description: "Query and manage PostgreSQL databases",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        envVariables: [
            {
                key: "POSTGRES_CONNECTION_STRING",
                description: "PostgreSQL connection string",
                required: true,
                placeholder: "postgresql://user:pass@localhost:5432/dbname"
            }
        ]
    },
    {
        name: "SQLite",
        description: "Query and manage SQLite databases",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite"],
        envVariables: []
    },
    {
        name: "Google Drive",
        description: "Access and manage Google Drive files",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gdrive"],
        envVariables: [
            {
                key: "GOOGLE_DRIVE_CREDENTIALS",
                description: "Google Drive service account credentials (JSON)",
                required: true,
                placeholder: "Path to credentials.json file"
            }
        ]
    }
];
