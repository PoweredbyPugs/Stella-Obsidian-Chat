import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Modal, MarkdownRenderer, Menu, Notice, TFile } from 'obsidian';

// Import types from modular structure
import {
    Conversation,
    Message,
    MCPServer,
    MCPServerTemplate,
    MCPCapabilities,
    MCPTool,
    MCPResource,
    MCPPrompt,
    MCPMessage,
    StellaSettings,
    QuickAddCommand,
    ContextNote,
    CommandDefinition,
    DEFAULT_SETTINGS,
    MCP_SERVER_TEMPLATES
} from './src/types';

// Import services from modular structure
import { FetchManager } from './src/services/fetch';
import { CacheManager } from './src/services/cache';
import { AsyncLogger } from './src/services/logger';
import { MCPClientManager } from './src/services/mcp/client';

// Import views (modals)
import {
    ConversationHistoryModal,
    NoteSelectorModal,
    createSystemPromptModal,
    createMentalModelModal,
    FolderSuggestModal,
    FileSuggestModal
} from './src/views';

// Import providers
import {
    getProvider,
    buildMessagesArray,
    ProviderContext,
    StreamCallbacks,
    LLMProviderWithMCP,
    MCPContext,
    listOpenRouterModels,
    listHermesModels
} from './src/providers';

export default class StellaPlugin extends Plugin {
    settings: StellaSettings;
    private logger: AsyncLogger;
    private cacheManager: CacheManager;
    private mcpManager: MCPClientManager;

    get cache(): CacheManager {
        return this.cacheManager;
    }

    get mcp(): MCPClientManager {
        return this.mcpManager;
    }

    get mcpClientManager(): MCPClientManager {
        return this.mcpManager;
    }

    // MCP Server Initialization
    async initializeMCPServers(): Promise<void> {
        this.logger.log('Initializing MCP servers...');

        for (const serverConfig of this.settings.mcpServers) {
            try {
                const success = await this.mcpManager.addServer(serverConfig);
                if (success) {
                    this.logger.log(`Successfully connected to MCP server: ${serverConfig.name}`);
                } else {
                    this.logger.warn(`Failed to connect to MCP server: ${serverConfig.name}`);
                }
            } catch (error) {
                this.logger.error(`Error connecting to MCP server ${serverConfig.name}:`, error);
            }
        }

        const connectedCount = this.mcpManager.getConnectedServers().length;
        this.logger.log(`MCP initialization complete. Connected to ${connectedCount} server(s).`);
    }

    async onload() {
        // Initialize async logger, cache manager, and MCP manager
        this.logger = new AsyncLogger();
        this.cacheManager = new CacheManager();
        this.mcpManager = new MCPClientManager(this.logger);
        this.logger.log('Stella plugin loading...');
        await this.loadSettings();

        // Initialize MCP servers in background (non-blocking)
        if (this.settings.mcpEnabled) {
            this.initializeMCPServers().catch(error => {
                this.logger.error('Failed to initialize MCP servers:', error);
            });
        }

        // Register chat view
        this.registerView(
            CHAT_VIEW_TYPE,
            (leaf) => new StellaChatView(leaf, this)
        );

        // Add ribbon icon to open chat
        this.addRibbonIcon('message-circle', 'Open Stella Chat', () => {
            this.activateView();
        });

        // Add command to open chat
        this.addCommand({
            id: 'open-stella-chat',
            name: 'Open Stella Chat',
            callback: () => {
                this.activateView();
            }
        });

        // Add settings tab
        this.addSettingTab(new StellaSettingTab(this.app, this));

        // Force update model info in existing chat views after a delay
        setTimeout(() => {
            this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                const chatView = leaf.view as StellaChatView;
                if (chatView && chatView.updateModelInfo) {
                    chatView.updateModelInfo(chatView.modelInfoContainer);
                }
            });
        }, 1000);

        // Right-click → "Send selection to new Stella chat". Appears in the
        // editor context menu whenever there's non-empty selected text. Opens
        // / reveals the chat view, starts a fresh conversation, pre-fills the
        // input with the selection, and focuses the input so the user can add
        // framing context ("explain this", "summarize", etc.) before sending.
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                const selection = editor.getSelection();
                if (!selection || !selection.trim()) return;
                menu.addItem((item) => {
                    item
                        .setTitle('Send selection to new Stella chat')
                        .setIcon('message-circle')
                        .onClick(async () => {
                            await this.sendSelectionToNewChat(selection);
                        });
                });
            })
        );

        // Four Winds integration: open Stella with seed note in a new conversation
        const fourWindsRef = (this.app.workspace as any).on('four-winds:process-seed', async (data: any) => {
            console.log('[Stella] four-winds:process-seed received', data);
            // Ensure view exists without destroying it
            let leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
            if (leaves.length === 0) {
                await this.app.workspace.getRightLeaf(false).setViewState({
                    type: CHAT_VIEW_TYPE,
                    active: true,
                });
                leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
            }
            if (leaves.length > 0) {
                this.app.workspace.revealLeaf(leaves[0]);
                const chatView = leaves[0].view as StellaChatView;
                chatView.startNewConversation();
                chatView.contextNotes = [];
                const file = this.app.vault.getAbstractFileByPath(data.filePath);
                console.log('[Stella] file resolved:', file?.path);
                if (file && chatView?.addNoteToContext) {
                    await chatView.addNoteToContext(file);
                    console.log('[Stella] context notes:', chatView.contextNotes.length);
                }
            }
        });
        this.register(() => this.app.workspace.offref(fourWindsRef));
    }

    async onunload() {
        this.logger.log('Stella plugin unloading...');
        this.logger.destroy();
        // Note: We don't clear cache on unload to preserve cached data between sessions
        this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Add safety check for missing background settings (backward compatibility)
        if (typeof this.settings.backgroundImage === 'undefined') {
            this.settings.backgroundImage = '';
            this.settings.backgroundMode = 'centered';
            this.settings.backgroundOpacity = 0.5;
        }

        // Hermes moved from the dashboard WebSocket (port 9119) to the
        // gateway API server (port 8642). Point old dashboard URLs at the
        // same host's API server and drop the old model sentinel.
        const hermesUrl = (this.settings.hermesUrl || '').trim();
        if (/:9119(\/|$)/.test(hermesUrl)) {
            this.settings.hermesUrl = hermesUrl.replace(/^(wss?|https?):/i, 'http:').replace(/:9119(\/.*)?$/, ':8642');
        }
        if (this.settings.model === 'hermes:agent') {
            this.settings.model = '';
        }

        // Ensure conversations array exists
        if (!this.settings.conversations) {
            this.settings.conversations = [];
        }

        this.logger.log(`Loaded settings - Conversations count: ${this.settings.conversations.length}`);
    }

    async saveSettings() {
        // Add safeguards to prevent data loss
        if (!this.settings.conversations) {
            this.logger.warn('Conversations array is missing, preserving existing data');
            const existingData = await this.loadData();
            if (existingData && existingData.conversations) {
                this.settings.conversations = existingData.conversations;
            } else {
                this.settings.conversations = [];
            }
        }

        this.logger.log(`Saving settings - Conversations count: ${this.settings.conversations.length}`);
        await this.saveData(this.settings);

        // Invalidate conversation metadata cache when settings change
        this.cacheManager.invalidateConversationData();
    }

    async activateView() {
        this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);

        await this.app.workspace.getRightLeaf(false).setViewState({
            type: CHAT_VIEW_TYPE,
            active: true,
        });

        this.app.workspace.revealLeaf(
            this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
        );
    }

    /** Open / reveal the chat view, start a fresh conversation, and pre-fill
     * the input with the supplied text. Focuses the input. Does NOT auto-send
     * — the user usually wants to add framing ("summarize this", "explain", etc.)
     * before hitting return. */
    async sendSelectionToNewChat(selection: string) {
        // Get or create the chat leaf without detaching existing leaves so any
        // open conversation isn't yanked out from under the user. Mirrors the
        // four-winds:process-seed pattern above.
        let leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
        if (leaves.length === 0) {
            await this.app.workspace.getRightLeaf(false).setViewState({
                type: CHAT_VIEW_TYPE,
                active: true,
            });
            leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
        }
        if (leaves.length === 0) {
            new Notice('Could not open Stella chat view.');
            return;
        }
        this.app.workspace.revealLeaf(leaves[0]);

        const chatView = leaves[0].view as StellaChatView;
        if (!chatView || typeof chatView.startNewConversation !== 'function') {
            new Notice('Stella chat view is not ready yet — try again in a moment.');
            return;
        }
        chatView.startNewConversation();

        // Pre-fill the input. The StellaChatView constructor wires the
        // textarea as `chatInput`; it may not be attached on the very first
        // call after view creation, so retry briefly if needed.
        const fill = () => {
            if (chatView.chatInput) {
                chatView.chatInput.value = selection;
                chatView.chatInput.focus();
                // Move caret to end so a follow-up keystroke appends rather
                // than overwriting selected text.
                const len = chatView.chatInput.value.length;
                chatView.chatInput.setSelectionRange(len, len);
                return true;
            }
            return false;
        };
        if (!fill()) {
            setTimeout(() => { fill(); }, 150);
        }
    }
}

// Chat View Constants
const CHAT_VIEW_TYPE = "stella-mcp-chat-view";

// Chat View Class - Smart Chat inspired UI
class StellaChatView extends ItemView {
    plugin: StellaPlugin;
    private logger: AsyncLogger;
    chatContainer: HTMLElement;
    headerContainer: HTMLElement;
    inputContainer: HTMLElement;
    messagesContainer: HTMLElement;
    chatInput: HTMLTextAreaElement;
    conversationNameInput: HTMLInputElement;
    modelInfoContainer: HTMLElement;
    systemPromptIndicator: HTMLElement;
    conversations: any[] = [];
    currentConversationId: string | null = null;
    chatHistory: Array<{role: string, content: string, timestamp: number}> = [];
    currentSystemPrompt: string | null = null;
    currentSystemPromptFilename: string | null = null;
    currentMentalModel: string | null = null;
    currentMentalModelFilename: string | null = null;
    mentalModelIndicator: HTMLElement;
    // Message pagination state
    private messagePageSize = 50; // Show 50 messages at a time
    private currentMessagePage = 0;
    private totalMessagePages = 0;
    private isLoadingMoreMessages = false;
    contextNotes: Array<{name: string, content: string}> = [];
    contextIndicator: HTMLElement;
    // MCP context state
    activeMCPServers: Array<{name: string, tools: MCPTool[], prompts: MCPPrompt[], resources?: MCPResource[], highlightedTools?: string[]}> = [];
    mcpIndicator: HTMLElement;
    noteIndicator: HTMLElement;

    // Available commands list (keep this updated when adding new commands)
    private readonly availableCommands = [
        { command: '/help', description: 'Show all available commands' },
        { command: '/sys', description: 'Load system prompt from file' },
        { command: '/sysclear', description: 'Clear current system prompt' },
        { command: '/model', description: 'Load mental model from file' },
        { command: '/modelclear', description: 'Clear current mental model' },
        { command: '/mcp', description: 'Connect to MCP server' },
        { command: '/mcpclear', description: 'Clear MCP connections' },
        { command: '/clear', description: 'Clear all context and start new conversation' },
        { command: '/new', description: 'Start new conversation' },
        { command: '/del', description: 'Delete current conversation' },
        { command: '/history', description: 'Show conversation history' },
        { command: '/name', description: 'Rename current conversation' },
        { command: '/settings', description: 'Open plugin settings' },
        { command: '/hide', description: 'Toggle header visibility' }
    ];

    constructor(leaf: WorkspaceLeaf, plugin: StellaPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.logger = new AsyncLogger();
    }

    getViewType() {
        return CHAT_VIEW_TYPE;
    }

    getDisplayText() {
        return "Stella";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('stella-mcp-chat-container');

        this.buildChatUI(container);
        this.loadConversations();
        this.updateHeaderVisibility();
        this.updateBackgroundImage();
    }

    buildChatUI(container: Element) {
        // Store container reference for background image
        this.chatContainer = container as HTMLElement;

        // Header with clean layout
        const header = container.createEl('div', { cls: 'stella-chat-header' });
        this.headerContainer = header;

        // Left side: Editable conversation name
        const leftControls = header.createEl('div', { cls: 'stella-header-left' });

        this.conversationNameInput = leftControls.createEl('input', {
            cls: 'stella-conversation-name',
            type: 'text',
            value: 'Current Chat'
        });
        this.conversationNameInput.addEventListener('blur', () => {
            this.saveConversationName();
        });
        this.conversationNameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.conversationNameInput.blur();
            }
        });

        // Right side: Model info + Action buttons
        const rightControls = header.createEl('div', { cls: 'stella-header-right' });

        // Model info inline
        this.modelInfoContainer = rightControls.createEl('span', { cls: 'stella-model-info' });
        this.updateModelInfo(this.modelInfoContainer);

        // Plus button for new chat
        const newChatBtn = rightControls.createEl('button', {
            cls: 'stella-action-btn',
            attr: { 'aria-label': 'New chat' }
        });
        newChatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
        newChatBtn.addEventListener('click', () => {
            this.startNewConversation();
        });

        // History button (clock)
        const historyBtn = rightControls.createEl('button', {
            cls: 'stella-action-btn',
            attr: { 'aria-label': 'Chat history' }
        });
        historyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12,6 12,12 16,14"></polyline></svg>';
        historyBtn.addEventListener('click', () => {
            try {
                this.showChatHistory();
            } catch (error) {
                this.logger.error('Error showing chat history:', error);
                // Fallback: just log that history feature is coming soon
                console.log('Chat history feature will be implemented in a future update.');
            }
        });

        // Settings button
        const settingsBtn = rightControls.createEl('button', {
            cls: 'stella-action-btn',
            attr: { 'aria-label': 'Settings' }
        });
        settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
        settingsBtn.addEventListener('click', () => {
            this.openSettings();
        });

        // Messages container
        this.messagesContainer = container.createEl('div', { cls: 'stella-messages-container' });

        // Context notes indicator (above input)
        this.contextIndicator = container.createEl('div', {
            cls: 'stella-context-indicator'
        });
        this.updateContextIndicator();

        // Input container at bottom
        this.inputContainer = container.createEl('div', { cls: 'stella-input-container' });

        // Input field
        this.chatInput = this.inputContainer.createEl('textarea', {
            cls: 'stella-chat-input'
        });

        // System prompt indicator (minimal, in input area)
        this.systemPromptIndicator = this.inputContainer.createEl('div', {
            cls: 'stella-system-prompt-indicator',
            attr: { 'title': 'System prompt loaded - use /sysclear to remove' }
        });
        this.updateSystemPromptIndicator();

        // Mental model indicator (minimal, in input area)
        this.mentalModelIndicator = this.inputContainer.createEl('div', {
            cls: 'stella-mental-model-indicator',
            attr: { 'title': 'Mental model loaded - use /modelclear to remove' }
        });
        this.updateMentalModelIndicator();

        // MCP indicator (minimal, in input area)
        this.mcpIndicator = this.inputContainer.createEl('div', {
            cls: 'stella-mcp-indicator'
        });

        // Note context indicator (minimal, in input area)
        this.noteIndicator = this.inputContainer.createEl('div', {
            cls: 'stella-note-indicator'
        });
        this.updateMCPIndicator();
        // Initialize the note indicator too — updateContextIndicator() ran
        // before this element existed (its update early-returned), and an
        // uninitialized indicator renders as an empty dot above the input.
        this.updateNoteIndicator();

        // Event listeners for input only
        this.chatInput.addEventListener('keydown', (e) => {
            if (e.key === '@') {
                // Prevent the @ character from appearing in the input
                e.preventDefault();
                // Show note selector modal
                this.showNoteSelector();
                return;
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const message = this.chatInput.value.trim();
                console.log('Enter pressed with message:', message);

                if (message === '/sys') {
                    this.showSystemPromptSelector();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/sysclear') {
                    this.unloadSystemPrompt();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/model') {
                    this.showMentalModelSelector();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/modelclear') {
                    this.unloadMentalModel();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/mcp') {
                    this.showMCPSelector();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/new') {
                    this.startNewConversation();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/del') {
                    this.deleteCurrentConversationAndStartNew();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/history') {
                    this.showChatHistory();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/settings') {
                    this.openPluginSettings();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/name') {
                    this.showNameInput();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/hide') {
                    this.toggleHeader();
                    this.chatInput.value = '';
                    return;
                }

                if (message === '/help') {
                    this.showHelpMessage();
                    this.chatInput.value = '';
                    return;
                }

                this.sendMessage();
            }
        });


        // Initialize background image
        this.updateBackgroundImage();
    }


    async sendMessage() {
        const message = this.chatInput.value.trim();
        if (!message) return;

        // Check for /sys command FIRST
        if (message === '/sys') {
            this.showSystemPromptSelector();
            this.chatInput.value = '';
            return;
        }

        // Check for /sysclear command
        if (message === '/sysclear') {
            this.unloadSystemPrompt();
            this.chatInput.value = '';
            return;
        }

        // Check for /model command
        if (message === '/model') {
            this.showMentalModelSelector();
            this.chatInput.value = '';
            return;
        }

        // Check for /modelclear command
        if (message === '/modelclear') {
            this.unloadMentalModel();
            this.chatInput.value = '';
            return;
        }

        // Check for /mcp command
        if (message === '/mcp') {
            this.showMCPSelector();
            this.chatInput.value = '';
            return;
        }

        // Check for /mcpclear command
        if (message === '/mcpclear') {
            this.clearMCPContext();
            this.chatInput.value = '';
            return;
        }

        // Check for universal /clear command
        if (message === '/clear') {
            this.clearAllContext();
            this.chatInput.value = '';
            return;
        }

        // Check for any slash commands to prevent sending them as regular messages
        if (message.startsWith('/')) {
            this.logger.warn(`Unknown slash command detected: ${message}`);
            const commandList = this.availableCommands.map(cmd => cmd.command).join(', ');
            this.addMessage(`Unknown command: ${message}. Available commands: ${commandList}`, 'error');
            this.chatInput.value = '';
            return;
        }

        // Add user message to UI
        const userMessageEl = this.addMessage(message, 'user');
        this.chatInput.value = '';

        // Check for MCP auto-detection in the message
        await this.detectAndActivateMCP(message);

        // Create loading animation right after user message
        const loadingOverlay = this.messagesContainer.createDiv('stella-cat-loading-overlay');

        // Show loading animation with smooth transition
        setTimeout(() => {
            loadingOverlay.classList.add('stella-cat-loading-visible');
        }, 100);

        // Auto-scroll to the loading animation after it's visible
        setTimeout(() => {
            loadingOverlay.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Also scroll the messages container to bottom
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }, 200);

        // Left side: Cat + Timer grouped together
        const catTimerGroup = loadingOverlay.createDiv('stella-cat-timer-group');

        // Bulbasaur GIF (direct, no container) - try loading as data URL
        const catSprite = catTimerGroup.createEl('img', {
            cls: 'stella-cat-sprite',
            attr: {
                alt: 'Bulbasaur loading animation'
            }
        });

        // Load GIF as data URL
        this.loadGifAsDataUrl(catSprite);

        // Timer next to cat
        const timerText = catTimerGroup.createDiv('stella-countdown-timer');

        // Right side: Token counter (if enabled)
        let tokenCounter: HTMLElement | null = null;
        let mcpStatus: HTMLElement | null = null;
        if (this.plugin.settings.showTokenCount) {
            tokenCounter = loadingOverlay.createDiv('stella-token-counter-floating');
            tokenCounter.textContent = 'Estimating tokens...';
        }

        // MCP tool execution status (hidden initially, only shows during execution)
        if (this.activeMCPServers && this.activeMCPServers.length > 0) {
            mcpStatus = loadingOverlay.createDiv('stella-mcp-status-floating');
            mcpStatus.textContent = '';
            mcpStatus.style.display = 'none'; // Hidden by default
            // Position it in the same area as token counter but above it
            mcpStatus.style.position = 'absolute';
            mcpStatus.style.right = '40px';
            mcpStatus.style.top = tokenCounter ? '60px' : '80px';
            mcpStatus.style.fontSize = '12px';
            mcpStatus.style.color = 'var(--text-muted)';
            mcpStatus.style.backgroundColor = 'var(--background-secondary)';
            mcpStatus.style.padding = '4px 8px';
            mcpStatus.style.borderRadius = '12px';
            mcpStatus.style.border = '1px solid var(--background-modifier-border)';
            mcpStatus.style.zIndex = '1001';
        }

        // Estimate tokens for display
        const estimatedTokens = this.estimateTokens(message + this.buildSystemMessage());
        let elapsedSeconds = 0;

        // Set initial timer
        timerText.textContent = `${elapsedSeconds}s`;

        // Smooth fade in animation
        setTimeout(() => {
            loadingOverlay.classList.add('stella-cat-loading-visible');
        }, 50);

        let displayedTokens = Math.floor(estimatedTokens * 0.3); // Start at 30% of estimated

        // Start count-up timer
        const loadingInterval = setInterval(() => {
            elapsedSeconds++;
            timerText.textContent = `${elapsedSeconds}s`;

            // Update token counter gradually (simulate progressive token count)
            if (tokenCounter) {
                // Increase tokens more slowly as time goes on
                const increment = Math.max(1, Math.floor(estimatedTokens / (elapsedSeconds + 10)));
                displayedTokens = Math.min(displayedTokens + increment, estimatedTokens);
                tokenCounter.textContent = `${displayedTokens} tokens`;
            }
        }, 1000); // Update every second

        try {
            // Use regular API call
            const response = await this.callLLM(message);

            // Stop the loading animation and fade out
            clearInterval(loadingInterval);
            this.hideLoadingAnimation(loadingOverlay);

            // Calculate final token count for response
            const responseTokens = this.estimateTokens(response);
            const totalTokens = estimatedTokens + responseTokens;

            if (tokenCounter) {
                tokenCounter.textContent = `${totalTokens} tokens`;
            }

            // Small delay to show completed bar, then show response
            setTimeout(() => {
                // Add actual response with token count if enabled
                const responseEl = this.addMessage(response, 'assistant');
                if (this.plugin.settings.showTokenCount) {
                    const responseContentEl = responseEl.querySelector('.stella-message-content') as HTMLElement;
                    const finalTokenCounter = responseContentEl.createDiv('stella-token-counter stella-token-final');
                    finalTokenCounter.textContent = `${totalTokens} tokens`;
                }
            }, 300);

        } catch (error) {
            // Clear loading animation and show error
            clearInterval(loadingInterval);
            this.hideLoadingAnimation(loadingOverlay);
            this.addMessage(`Error: ${error.message}`, 'error');
        }
    }

    hideLoadingAnimation(loadingOverlay: HTMLElement) {
        // Add fade out animation
        loadingOverlay.classList.add('stella-cat-loading-hiding');

        // Remove element after animation completes
        setTimeout(() => {
            loadingOverlay.remove();
        }, 300);
    }

    async loadGifAsDataUrl(imgElement: HTMLImageElement) {
        // Check for custom loading GIF first
        const customGif = this.plugin.settings.loadingGif;
        if (customGif && customGif.trim() !== '') {
            try {
                // Try to get the file from vault and use Obsidian's resource path
                const file = this.app.vault.getAbstractFileByPath(customGif);
                if (file) {
                    const resourcePath = this.app.vault.getResourcePath(file as any);
                    imgElement.src = resourcePath;
                    return;
                }
                // Fallback: try reading as binary
                const adapter = this.app.vault.adapter;
                if ('readBinary' in adapter) {
                    const data = await adapter.readBinary(customGif);
                    const blob = new Blob([data], { type: 'image/gif' });
                    const reader = new FileReader();
                    reader.onload = () => {
                        imgElement.src = reader.result as string;
                    };
                    reader.readAsDataURL(blob);
                    return;
                }
            } catch (customError) {
                console.warn('Failed to load custom GIF:', customError);
            }
        }

        // Try to load default bulbasaur.gif from plugin directory using Node.js fs
        try {
            const adapter = this.app.vault.adapter as any;
            if (adapter.getBasePath) {
                const basePath = adapter.getBasePath();
                const path = require('path');
                const fs = require('fs');
                const gifPath = path.join(basePath, '.obsidian', 'plugins', 'Stella', 'bulbasaur.gif');
                if (fs.existsSync(gifPath)) {
                    const data = fs.readFileSync(gifPath);
                    const base64 = data.toString('base64');
                    imgElement.src = `data:image/gif;base64,${base64}`;
                    return;
                }
            }
        } catch (error) {
            console.warn('Failed to load default GIF from plugin directory:', error);
        }

        // Final fallback: CSS-based loading animation
        this.createCSSLoadingAnimation(imgElement);
    }

    createCSSLoadingAnimation(imgElement: HTMLImageElement) {
        imgElement.style.width = '64px';
        imgElement.style.height = '64px';
        imgElement.style.background = 'linear-gradient(135deg, var(--interactive-accent) 0%, var(--interactive-accent-hover) 100%)';
        imgElement.style.borderRadius = '50%';
        imgElement.style.animation = 'stella-pulse 1.5s ease-in-out infinite';

        // Add keyframes if not already added
        if (!document.getElementById('stella-loading-keyframes')) {
            const style = document.createElement('style');
            style.id = 'stella-loading-keyframes';
            style.textContent = `
                @keyframes stella-pulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.1); opacity: 0.7; }
                }
            `;
            document.head.appendChild(style);
        }
    }

    addMessage(content: string, type: 'user' | 'assistant' | 'error' | 'system', isTemp = false): HTMLElement {
        // Add to chat history if not temporary
        if (!isTemp) {
            this.chatHistory.push({
                role: type === 'user' ? 'user' : 'assistant',
                content: content,
                timestamp: Date.now()
            });
            // Auto-save to conversation if we have one
            if (this.currentConversationId) {
                this.saveCurrentConversation();
            }
        }
        return this.addMessageToUI(content, type, isTemp);
    }

    addMessageToUI(content: string, type: 'user' | 'assistant' | 'error' | 'system', isTemp = false): HTMLElement {
        const messageEl = this.messagesContainer.createEl('div', {
            cls: `stella-message stella-message-${type}`
        });

        if (isTemp) {
            messageEl.addClass('stella-message-temp');
        }

        // Content (no avatar icons)
        const contentEl = messageEl.createEl('div', { cls: 'stella-message-content' });

        if (type === 'assistant' && !isTemp) {
            // Render markdown for assistant messages
            this.renderMarkdown(contentEl, content);
        } else {
            // For user messages, render text but parse wiki links
            this.renderTextWithWikiLinks(contentEl, content);
        }

        // Add context menu for text selection and QuickAdd integration
        this.setupContextMenu(contentEl);

        // No more individual copy buttons - moved to lower bar

        // Removed auto-scroll to allow manual scrolling during generation
        return messageEl;
    }

    // Simple token estimation (roughly 4 characters per token)
    estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    setupContextMenu(contentEl: HTMLElement) {
        contentEl.addEventListener('contextmenu', (e) => {
            const selection = window.getSelection();
            const selectedText = selection?.toString().trim();

            if (selectedText) {
                e.preventDefault();
                this.showQuickAddContextMenu(e, selectedText);
            }
        });
    }

    showQuickAddContextMenu(event: MouseEvent, selectedText: string) {
        const menu = new Menu();

        // Add QuickAdd commands from settings
        this.plugin.settings.quickAddCommands.forEach((command) => {
            menu.addItem((item) =>
                item
                    .setTitle(command.name)
                    .setIcon('plus-circle')
                    .onClick(() => {
                        this.executeQuickAddCommand(command.id, selectedText);
                    })
            );
        });

        if (this.plugin.settings.quickAddCommands.length === 0) {
            menu.addItem((item) =>
                item
                    .setTitle('No QuickAdd commands configured')
                    .setDisabled(true)
            );
        }

        menu.showAtMouseEvent(event);
    }

    async executeQuickAddCommand(commandId: string, selectedText: string) {
        try {
            // Check if QuickAdd plugin is available
            const plugins = (this.app as any).plugins;
            const quickAddPlugin = plugins?.plugins?.['quickadd'];

            if (!quickAddPlugin) {
                new Notice('QuickAdd plugin is not installed or enabled');
                return;
            }

            // Store selected text in a variable that QuickAdd can access
            (window as any).stellaSelectedText = selectedText;

            // Try to execute the QuickAdd command
            const commands = (this.app as any).commands;
            if (!commands) {
                new Notice('Commands system not available');
                return;
            }

            // Get all available commands to help with debugging
            const allCommands = commands.listCommands();
            console.log('Available QuickAdd commands:', allCommands.filter((cmd: any) => cmd.id.includes('quickadd')));

            // Try multiple possible command ID formats
            const possibleCommandIds = [
                `quickadd:choice:${commandId}`,
                `quickadd:${commandId}`,
                commandId,
                `QuickAdd: ${commandId}`,
                // Case variations
                commandId.toLowerCase(),
                commandId.toUpperCase()
            ];

            let commandExecuted = false;

            for (const cmdId of possibleCommandIds) {
                try {
                    const foundCommand = allCommands.find((cmd: any) =>
                        cmd.id === cmdId ||
                        cmd.id.toLowerCase() === cmdId.toLowerCase() ||
                        cmd.name?.toLowerCase().includes(commandId.toLowerCase())
                    );

                    if (foundCommand) {
                        console.log(`Found QuickAdd command: ${foundCommand.id} (${foundCommand.name})`);
                        commands.executeCommandById(foundCommand.id);
                        new Notice(`Executed QuickAdd command: ${foundCommand.name}`);
                        commandExecuted = true;
                        break;
                    }
                } catch (error) {
                    console.log(`Failed to execute command ID: ${cmdId}`, error);
                }
            }

            if (!commandExecuted) {
                // List available QuickAdd commands for user reference
                const quickAddCommands = allCommands.filter((cmd: any) => cmd.id.includes('quickadd'));
                console.log('Available QuickAdd commands:', quickAddCommands.map((cmd: any) => ({ id: cmd.id, name: cmd.name })));

                if (quickAddCommands.length > 0) {
                    new Notice(`QuickAdd command '${commandId}' not found. Available commands: ${quickAddCommands.map((cmd: any) => cmd.name).join(', ')}`);
                } else {
                    new Notice('No QuickAdd commands found. Make sure QuickAdd is properly configured.');
                }
            }
        } catch (error) {
            new Notice('Failed to execute QuickAdd command');
            console.error('QuickAdd execution error:', error);
        }
    }

    async renderMarkdown(container: HTMLElement, content: string) {
        // Use Obsidian's MarkdownRenderer first
        try {
            await MarkdownRenderer.renderMarkdown(content, container, '', this);
        } catch (error) {
            console.error('Error rendering markdown:', error);
            // Fallback to plain text
            container.textContent = content;
        }

        // Always post-process to handle wiki links (whether Obsidian processed them or not)
        this.processAllWikiLinks(container, content);
    }

    preprocessWikiLinks(content: string): string {
        // Convert wiki links to temporary placeholders that markdown won't interfere with
        const wikiLinkRegex = /\[\[([^\]]+?)(?:\|([^\]]+?))?\]\]/g;
        let processedContent = content;

        processedContent = processedContent.replace(wikiLinkRegex, (match, noteName, displayText) => {
            // Create a unique placeholder that won't be affected by markdown processing
            const placeholder = `__WIKILINK__${noteName}__${displayText || noteName}__ENDWIKILINK__`;
            return placeholder;
        });

        return processedContent;
    }

    enhanceWikiLinks(container: HTMLElement) {
        // First, process wiki link placeholders back to clickable links
        this.processWikiLinkPlaceholders(container);

        // Then find all internal links (wiki links) rendered by Obsidian
        const wikiLinks = container.querySelectorAll('a.internal-link');

        wikiLinks.forEach((link: HTMLAnchorElement) => {
            // Get the note name from the href attribute
            const href = link.getAttribute('href');
            if (!href) return;

            // Extract note name from href (format is usually just the note name)
            const noteName = decodeURIComponent(href);

            // Check if the note exists in the vault
            const file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
            const exists = file !== null;

            // Add custom styling based on existence
            link.classList.add('stella-wiki-link');
            if (!exists) {
                link.classList.add('stella-wiki-link-missing');
            }

            // Override click behavior
            link.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Check for Ctrl+Click (or Cmd+Click on Mac)
                if (e.ctrlKey || e.metaKey) {
                    // Use Obsidian's native link opening
                    if (exists) {
                        this.app.workspace.openLinkText(noteName, '');
                    }
                } else {
                    // Regular click - add to context
                    if (exists) {
                        this.addNoteToContext(file);
                    } else {
                        // Show error for missing notes
                        this.addMessage(`Note "${noteName}" not found in vault`, 'error');
                    }
                }
            });

            // Update tooltip
            const existingTitle = link.getAttribute('title') || '';
            link.setAttribute('title',
                exists
                    ? `${existingTitle ? existingTitle + ' | ' : ''}Click to add to context, Ctrl+Click to open`
                    : `Note "${noteName}" not found`
            );
        });
    }

    processWikiLinkPlaceholders(container: HTMLElement) {
        // Find and replace wiki link placeholders with actual clickable links
        const placeholderRegex = /__WIKILINK__([^_]+?)__([^_]+?)__ENDWIKILINK__/g;

        // Get all text nodes and replace placeholders
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT
        );

        const textNodes: Text[] = [];
        let node;
        while ((node = walker.nextNode())) {
            if (node.textContent && node.textContent.includes('__WIKILINK__')) {
                textNodes.push(node as Text);
            }
        }

        textNodes.forEach((textNode) => {
            const content = textNode.textContent || '';
            if (placeholderRegex.test(content)) {
                // Create a document fragment to hold the new content
                const fragment = document.createDocumentFragment();
                let lastIndex = 0;
                let match;

                placeholderRegex.lastIndex = 0; // Reset regex
                while ((match = placeholderRegex.exec(content)) !== null) {
                    // Add text before the placeholder
                    if (match.index > lastIndex) {
                        const textBefore = content.slice(lastIndex, match.index);
                        fragment.appendChild(document.createTextNode(textBefore));
                    }

                    // Create wiki link element
                    const noteName = match[1];
                    const displayText = match[2];

                    const linkWrapper = document.createElement('span');
                    this.createWikiLinkElement(linkWrapper, noteName, displayText);
                    fragment.appendChild(linkWrapper.firstChild!);

                    lastIndex = match.index + match[0].length;
                }

                // Add remaining text
                if (lastIndex < content.length) {
                    const textAfter = content.slice(lastIndex);
                    fragment.appendChild(document.createTextNode(textAfter));
                }

                // Replace the text node with the fragment
                textNode.parentNode?.replaceChild(fragment, textNode);
            }
        });
    }

    processAllWikiLinks(container: HTMLElement, originalContent: string) {
        // First, enhance any wiki links that Obsidian successfully processed
        this.enhanceExistingWikiLinks(container);

        // Then, find and process any wiki links that weren't processed by Obsidian
        this.processUnprocessedWikiLinks(container, originalContent);
    }

    enhanceExistingWikiLinks(container: HTMLElement) {
        // Find all internal links already rendered by Obsidian
        const existingLinks = container.querySelectorAll('a.internal-link');

        existingLinks.forEach((link: HTMLAnchorElement) => {
            this.enhanceWikiLink(link);
        });
    }

    processUnprocessedWikiLinks(container: HTMLElement, originalContent: string) {
        // Find wiki link patterns in the original content
        const wikiLinkRegex = /\[\[([^\]]+?)(?:\|([^\]]+?))?\]\]/g;
        const matches = Array.from(originalContent.matchAll(wikiLinkRegex));

        if (matches.length === 0) return;

        console.log('Found wiki links to process:', matches.map(m => m[0]));

        // Get all text nodes in the container (recursively)
        const textNodes: Text[] = [];
        this.collectTextNodes(container, textNodes);

        console.log('Found text nodes:', textNodes.length);

        // Process each text node that contains wiki links
        textNodes.forEach((textNode, index) => {
            const content = textNode.textContent || '';
            if (content.includes('[[') && content.includes(']]')) {
                console.log(`Processing text node ${index}:`, content.substring(0, 100));
                this.replaceWikiLinksInTextNode(textNode, content);
            }
        });
    }

    collectTextNodes(node: Node, textNodes: Text[]) {
        if (node.nodeType === Node.TEXT_NODE) {
            textNodes.push(node as Text);
        } else {
            for (let child of Array.from(node.childNodes)) {
                this.collectTextNodes(child, textNodes);
            }
        }
    }

    replaceWikiLinksInTextNode(textNode: Text, content: string) {
        console.log('Replacing wiki links in text node:', content.substring(0, 100));

        const wikiLinkRegex = /\[\[([^\]]+?)(?:\|([^\]]+?))?\]\]/g;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        let replacements = 0;

        wikiLinkRegex.lastIndex = 0;
        while ((match = wikiLinkRegex.exec(content)) !== null) {
            // Add text before the link
            if (match.index > lastIndex) {
                const textBefore = content.slice(lastIndex, match.index);
                fragment.appendChild(document.createTextNode(textBefore));
            }

            // Create wiki link element
            const noteName = match[1].trim();
            const displayText = match[2] ? match[2].trim() : noteName;

            console.log(`Creating wiki link: ${noteName} -> ${displayText}`);
            const link = this.createWikiLink(noteName, displayText);
            fragment.appendChild(link);
            replacements++;

            lastIndex = match.index + match[0].length;
        }

        // Add remaining text
        if (lastIndex < content.length) {
            const textAfter = content.slice(lastIndex);
            fragment.appendChild(document.createTextNode(textAfter));
        }

        console.log(`Made ${replacements} wiki link replacements`);

        // Replace the text node with the fragment only if we made replacements
        if (replacements > 0 && textNode.parentNode) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
    }

    createWikiLink(noteName: string, displayText: string): HTMLAnchorElement {
        // Check if the note exists in the vault
        const file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
        const exists = file !== null;

        // Create link element
        const link = document.createElement('a');
        link.textContent = displayText;
        link.className = 'stella-wiki-link internal-link';

        if (!exists) {
            link.classList.add('stella-wiki-link-missing');
        }

        this.enhanceWikiLink(link, noteName, file);

        return link;
    }

    enhanceWikiLink(link: HTMLAnchorElement, noteName?: string, file?: any) {
        // Get note name if not provided
        if (!noteName) {
            const href = link.getAttribute('href');
            noteName = href ? decodeURIComponent(href) : link.textContent || '';
        }

        // Get file if not provided
        if (!file) {
            file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
        }

        const exists = file !== null;

        // Add styling
        link.classList.add('stella-wiki-link');
        if (!exists) {
            link.classList.add('stella-wiki-link-missing');
        }

        // Set up click behavior
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Check for Ctrl+Click (or Cmd+Click on Mac)
            if (e.ctrlKey || e.metaKey) {
                // Use Obsidian's native link opening
                if (exists) {
                    this.app.workspace.openLinkText(noteName!, '');
                }
            } else {
                // Regular click - add to context
                if (exists) {
                    this.addNoteToContext(file);
                } else {
                    // Show error for missing notes
                    this.addMessage(`Note "${noteName}" not found in vault`, 'error');
                }
            }
        });

        // Set tooltip
        link.setAttribute('title',
            exists
                ? `Click to add to context, Ctrl+Click to open`
                : `Note "${noteName}" not found`
        );
    }

    renderTextWithWikiLinks(container: HTMLElement, content: string) {
        // Clear container and set text content
        container.textContent = content;

        // Process wiki links using the unified method
        this.processAllWikiLinks(container, content);
    }

    createWikiLinkElement(container: HTMLElement, noteName: string, displayText: string) {
        // Check if the note exists in the vault
        const file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
        const exists = file !== null;

        // Create link element
        const link = container.createEl('a', {
            text: displayText,
            cls: ['stella-wiki-link', 'internal-link']
        });

        if (!exists) {
            link.classList.add('stella-wiki-link-missing');
        }

        // Set up click behavior
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Check for Ctrl+Click (or Cmd+Click on Mac)
            if (e.ctrlKey || e.metaKey) {
                // Use Obsidian's native link opening
                if (exists) {
                    this.app.workspace.openLinkText(noteName, '');
                }
            } else {
                // Regular click - add to context
                if (exists) {
                    this.addNoteToContext(file);
                } else {
                    // Show error for missing notes
                    this.addMessage(`Note "${noteName}" not found in vault`, 'error');
                }
            }
        });

        // Set tooltip
        link.setAttribute('title',
            exists
                ? `Click to add to context, Ctrl+Click to open`
                : `Note "${noteName}" not found`
        );
    }

    async addNoteToContext(file: any) {
        try {
            const content = await this.app.vault.read(file);

            // Check if already in context
            const existing = this.contextNotes.find(note => note.name === file.basename);
            if (existing) {
                this.addMessage(`"${file.basename}" is already in context`, 'error');
                return;
            }

            // Add to context
            this.contextNotes.push({
                name: file.basename,
                content: content
            });

            // Update context indicator
            this.updateContextIndicator();
        } catch (error) {
            this.addMessage(`Error loading "${file.basename}": ${error.message}`, 'error');
        }
    }

    async streamLLMResponse(message: string, contentEl: HTMLElement) {
        const { provider } = this.plugin.settings;
        let accumulatedResponse = '';
        let streamingSucceeded = false;

        const updateContent = (text: string) => {
            accumulatedResponse += text;
            // Render as plain text during streaming for performance
            contentEl.textContent = accumulatedResponse;
        };

        const finalizeContent = async () => {
            // Remove temporary class
            const messageEl = contentEl.closest('.stella-message');
            if (messageEl) {
                messageEl.removeClass('stella-message-temp');
            }

            // Final markdown rendering once streaming is complete
            contentEl.innerHTML = '';
            await this.renderMarkdown(contentEl, accumulatedResponse);

            // Add to chat history
            this.chatHistory.push({
                role: 'assistant',
                content: accumulatedResponse,
                timestamp: Date.now()
            });

            // Auto-save to conversation if we have one
            if (this.currentConversationId) {
                this.saveCurrentConversation();
            }

            streamingSucceeded = true;
        };

        try {
            console.log(`Attempting streaming for provider: ${provider}`);
            await this.streamLLM(message, updateContent, finalizeContent);
        } catch (error) {
            console.error(`Streaming failed for ${provider}, falling back to regular API:`, error);

            // If streaming failed, fall back to regular API call
            if (!streamingSucceeded) {
                try {
                    const response = await this.callLLM(message);

                    // Remove temporary class
                    const messageEl = contentEl.closest('.stella-message');
                    if (messageEl) {
                        messageEl.removeClass('stella-message-temp');
                    }

                    // Render the response
                    contentEl.innerHTML = '';
                    await this.renderMarkdown(contentEl, response);

                    // Add to chat history
                    this.chatHistory.push({
                        role: 'assistant',
                        content: response,
                        timestamp: Date.now()
                    });

                    // Auto-save to conversation if we have one
                    if (this.currentConversationId) {
                        this.saveCurrentConversation();
                    }

                    console.log(`Fallback API call succeeded for ${provider}`);
                } catch (fallbackError) {
                    console.error(`Both streaming and fallback failed for ${provider}:`, fallbackError);
                    throw fallbackError;
                }
            }
        }
    }

    // Build provider context from current view state
    private buildProviderContext(message: string): ProviderContext {
        const systemMessage = this.buildSystemMessage();
        const messages = buildMessagesArray(
            this.chatHistory,
            message,
            systemMessage || null
        );

        return {
            settings: this.plugin.settings,
            messages,
            systemMessage: systemMessage || null
        };
    }

    async callLLM(message: string): Promise<string> {
        const { provider: providerName } = this.plugin.settings;
        const provider = getProvider(providerName);

        if (!provider) {
            throw new Error(`Unsupported provider: ${providerName}`);
        }

        if (!provider.isConfigured(this.plugin.settings)) {
            throw new Error(`Please configure ${providerName} in settings`);
        }

        const context = this.buildProviderContext(message);

        // Special handling for Google with MCP
        if (providerName === 'google' && this.activeMCPServers && this.activeMCPServers.length > 0) {
            const mcpProvider = provider as LLMProviderWithMCP;
            if (mcpProvider.callWithMCP) {
                const mcpContext = this.buildMCPContext();
                return mcpProvider.callWithMCP(context, mcpContext);
            }
        }

        return provider.call(context);
    }

    // Build MCP context for providers that support tool calling
    private buildMCPContext(): MCPContext {
        const servers: Array<{ name: string; tools: Array<{ name: string; description: string; inputSchema: any }> }> = [];

        // Use activeMCPServers which already has tools loaded
        if (this.activeMCPServers && Array.isArray(this.activeMCPServers)) {
            for (const activeServer of this.activeMCPServers) {
                if (activeServer.tools && activeServer.tools.length > 0) {
                    servers.push({
                        name: activeServer.name,
                        tools: activeServer.tools.map(tool => ({
                            name: tool.name,
                            description: tool.description || '',
                            inputSchema: tool.inputSchema || {}
                        }))
                    });
                }
            }
        }

        return {
            servers,
            executeTool: async (functionName: string, args: any) => {
                return this.executeMCPTool(functionName, args);
            }
        };
    }

    async streamLLM(
        message: string,
        updateContent: (text: string) => void,
        finalizeContent: () => Promise<void>
    ): Promise<void> {
        const { provider: providerName } = this.plugin.settings;
        const provider = getProvider(providerName);

        if (!provider) {
            throw new Error(`Unsupported provider: ${providerName}`);
        }

        if (!provider.isConfigured(this.plugin.settings)) {
            throw new Error(`Please configure ${providerName} in settings`);
        }

        const context = this.buildProviderContext(message);
        const callbacks: StreamCallbacks = {
            onContent: updateContent,
            onComplete: finalizeContent
        };

        // Google streaming is disabled, will throw and fall back to regular API
        if (providerName === 'google') {
            throw new Error('Google streaming temporarily disabled');
        }

        await provider.stream(context, callbacks);
    }

    async callOpenAI(message: string): Promise<string> {
        if (!this.plugin.settings.openaiApiKey) {
            throw new Error('Please set your OpenAI API key in settings');
        }

        // Build messages array from chat history + current message
        const messages = [];

        // Add system message if available (using buildSystemMessage for consistency)
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            messages.push({ role: 'system', content: this.buildSystemMessage() });
            console.log('OpenAI: Including system message in request');
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`
            },
            body: JSON.stringify({
                model: this.plugin.settings.model,
                messages: messages,
                max_tokens: this.plugin.settings.maxTokens,
                temperature: this.plugin.settings.temperature
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async streamOpenAI(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        if (!this.plugin.settings.openaiApiKey) {
            throw new Error('Please set your OpenAI API key in settings');
        }

        // Build messages array from chat history + current message
        const messages = [];

        // Add system message if available
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            messages.push({ role: 'system', content: this.buildSystemMessage() });
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`
            },
            body: JSON.stringify({
                model: this.plugin.settings.model,
                messages: messages,
                max_tokens: this.plugin.settings.maxTokens,
                temperature: this.plugin.settings.temperature,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            await finalizeContent();
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) {
                                updateContent(content);
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        await finalizeContent();
    }

    async callAnthropic(message: string): Promise<string> {
        if (!this.plugin.settings.anthropicApiKey) {
            throw new Error('Please set your Anthropic API key in settings');
        }

        // Build messages array from chat history + current message
        const messages = [];

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.plugin.settings.anthropicApiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.plugin.settings.model,
                max_tokens: this.plugin.settings.maxTokens,
                temperature: this.plugin.settings.temperature,
                messages: messages,
                ...((this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) && {
                    system: this.buildSystemMessage()
                })
            })
        });

        if (!response.ok) {
            throw new Error(`Anthropic API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.content[0].text;
    }

    async streamAnthropic(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        if (!this.plugin.settings.anthropicApiKey) {
            throw new Error('Please set your Anthropic API key in settings');
        }

        // Build messages array from chat history + current message
        const messages = [];

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const requestBody: any = {
            model: this.plugin.settings.model,
            max_tokens: this.plugin.settings.maxTokens,
            temperature: this.plugin.settings.temperature,
            messages: messages,
            stream: true
        };

        // Add system message if available
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            requestBody.system = this.buildSystemMessage();
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.plugin.settings.anthropicApiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            await finalizeContent();
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.type === 'content_block_delta') {
                                const content = parsed.delta?.text;
                                if (content) {
                                    updateContent(content);
                                }
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        await finalizeContent();
    }

    async callGoogle(message: string, retryCount = 0): Promise<string> {
        if (!this.plugin.settings.googleApiKey) {
            throw new Error('Please set your Google API key in settings');
        }

        // Build contents array from chat history + current message
        const contents = [];
        for (const msg of this.chatHistory) {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }
        contents.push({
            role: 'user',
            parts: [{ text: message }]
        });

        if (this.currentSystemPrompt) {
            console.log('Google: Including system prompt in request');
        } else {
            console.log('Google: No system prompt to include');
        }

        const requestBody: any = {
            contents: contents,
            systemInstruction: (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) ? {
                parts: [{ text: this.buildSystemMessage() }]
            } : undefined,
            generationConfig: {
                temperature: this.plugin.settings.temperature,
                maxOutputTokens: this.plugin.settings.maxTokens
            }
        };

        // Add MCP tools as Google function declarations (same as streaming)
        if (this.activeMCPServers && this.activeMCPServers.length > 0) {
            const functionDeclarations: any[] = [];

            for (const server of this.activeMCPServers) {
                console.log(`Adding tools from MCP server (non-streaming): ${server.name}`, server);
                const tools = server.tools || [];
                for (const tool of tools) {
                    // Clean the input schema for Google API compatibility
                    let cleanedSchema = tool.inputSchema || {
                        type: "object",
                        properties: {},
                        required: []
                    };

                    // Remove fields that Google API doesn't accept
                    if (cleanedSchema && typeof cleanedSchema === 'object') {
                        const { $schema, additionalProperties, ...googleCompatibleSchema } = cleanedSchema;
                        cleanedSchema = googleCompatibleSchema;
                    }

                    const functionDecl = {
                        name: `${server.name}_${tool.name}`,
                        description: tool.description || `Execute ${tool.name} from ${server.name}`,
                        parameters: cleanedSchema
                    };
                    console.log(`Adding function declaration (non-streaming):`, functionDecl);
                    functionDeclarations.push(functionDecl);
                }
            }

            if (functionDeclarations.length > 0) {
                requestBody.tools = [{
                    functionDeclarations: functionDeclarations
                }];
                console.log(`Google API non-streaming request with ${functionDeclarations.length} MCP tools:`, requestBody.tools);
            }
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.plugin.settings.model}:generateContent?key=${this.plugin.settings.googleApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Google API error details:', {
                status: response.status,
                statusText: response.statusText,
                body: errorText
            });
            // Retry on 503 Service Unavailable (up to 2 retries)
            if (response.status === 503 && retryCount < 2) {
                console.log(`Retrying Google API call (attempt ${retryCount + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // Wait 1s, then 2s
                return this.callGoogle(message, retryCount + 1);
            }

            throw new Error(`Google API error (${response.status}): ${response.statusText}. ${errorText || 'Service temporarily unavailable'}`);
        }

        const data = await response.json();
        console.log('Google API non-streaming response:', data);

        // Handle function calls first with enhanced error handling
        const candidate = data?.candidates?.[0];
        if (!candidate) {
            throw new Error('No candidate in Google API response');
        }

        const functionCall = candidate.content?.parts?.find((part: any) => part.functionCall);

        if (functionCall && functionCall.functionCall) {
            console.log('Found function call in non-streaming response:', functionCall.functionCall);

            try {
                const functionName = functionCall.functionCall.name;
                const functionArgs = functionCall.functionCall.args || {};

                if (!functionName) {
                    throw new Error('Function call missing name');
                }

                const result = await this.executeMCPTool(functionName, functionArgs);
                console.log('MCP tool execution result (non-streaming):', result);

                // Make a follow-up call to Google with the function result
                const followUpContents = [...contents];
                followUpContents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: functionCall.functionCall.name,
                            response: result
                        }
                    }]
                });

                const followUpResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.plugin.settings.model}:generateContent?key=${this.plugin.settings.googleApiKey}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ...requestBody,
                        contents: followUpContents
                    })
                });

                if (followUpResponse.ok) {
                    const followUpData = await followUpResponse.json();
                    return followUpData.candidates[0].content.parts[0].text;
                }
            } catch (error) {
                console.error('MCP tool execution failed (non-streaming):', error);
                return `Error executing tool ${functionCall.functionCall.name}: ${error.message}`;
            }
        }

        // Regular text response
        return candidate.content.parts[0].text;
    }

    async streamGoogle(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        if (!this.plugin.settings.googleApiKey) {
            throw new Error('Please set your Google API key in settings');
        }

        console.log('Starting Google streaming...');

        // Build messages array for Google
        const contents = [];

        // Add system instruction if available
        let systemInstruction = null;
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            systemInstruction = { parts: [{ text: this.buildSystemMessage() }] };
            console.log('Google: Including system instruction');
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        });

        // Add current message
        contents.push({
            role: 'user',
            parts: [{ text: message }]
        });

        const requestBody: any = {
            contents: contents,
            generationConfig: {
                temperature: this.plugin.settings.temperature,
                maxOutputTokens: this.plugin.settings.maxTokens
            }
        };

        // Add MCP tools as Google function declarations
        if (this.activeMCPServers && this.activeMCPServers.length > 0) {
            const functionDeclarations: any[] = [];

            for (const server of this.activeMCPServers) {
                console.log(`Adding tools from MCP server: ${server.name}`, server);
                const tools = server.tools || [];
                for (const tool of tools) {
                    // Clean the input schema for Google API compatibility
                    let cleanedSchema = tool.inputSchema || {
                        type: "object",
                        properties: {},
                        required: []
                    };

                    // Remove fields that Google API doesn't accept
                    if (cleanedSchema && typeof cleanedSchema === 'object') {
                        const { $schema, additionalProperties, ...googleCompatibleSchema } = cleanedSchema;
                        cleanedSchema = googleCompatibleSchema;
                    }

                    const functionDecl = {
                        name: `${server.name}_${tool.name}`,
                        description: tool.description || `Execute ${tool.name} from ${server.name}`,
                        parameters: cleanedSchema
                    };
                    console.log(`Adding function declaration:`, functionDecl);
                    functionDeclarations.push(functionDecl);
                }
            }

            if (functionDeclarations.length > 0) {
                requestBody.tools = [{
                    functionDeclarations: functionDeclarations
                }];
                console.log(`Google API request with ${functionDeclarations.length} MCP tools:`, requestBody.tools);
            } else {
                console.log('No MCP tools available to add to Google function declarations');
            }
        } else {
            console.log('No active MCP servers for Google function calling');
        }

        if (systemInstruction) {
            requestBody.systemInstruction = systemInstruction;
        }

        console.log('Google request body:', requestBody);

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.plugin.settings.model}:streamGenerateContent?key=${this.plugin.settings.googleApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Google API error response:', error);
            throw new Error(`Google API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Process complete JSON objects
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    try {
                        // Google streaming might wrap responses
                        let jsonLine = line.trim();
                        if (jsonLine.startsWith('data: ')) {
                            jsonLine = jsonLine.slice(6).trim();
                        }

                        // Skip if it's just opening/closing brackets
                        if (jsonLine === '[' || jsonLine === ']' || jsonLine === '') {
                            continue;
                        }

                        // Handle comma-separated objects in array format
                        if (jsonLine.endsWith(',')) {
                            jsonLine = jsonLine.slice(0, -1);
                        }

                        const parsed = JSON.parse(jsonLine);
                        console.log('Google streaming chunk:', parsed);

                        // Handle both single object and array formats
                        const candidates = Array.isArray(parsed) ? parsed : [parsed];

                        for (const item of candidates) {
                            console.log('Processing Google streaming item:', item);

                            // Check for function calls first
                            const functionCall = item.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                            if (functionCall) {
                                console.log('Found function call from Google:', functionCall);

                                // Update MCP status to show tool execution
                                const mcpStatusEl = document.querySelector('.stella-mcp-status-floating') as HTMLElement;
                                if (mcpStatusEl) {
                                    mcpStatusEl.style.display = 'block';
                                    mcpStatusEl.textContent = `Executing: ${functionCall.name}`;
                                }

                                // Execute MCP tool
                                try {
                                    const functionName = functionCall?.name;
                                    const functionArgs = functionCall?.args || {};

                                    if (!functionName) {
                                        throw new Error('Function call missing name in streaming response');
                                    }

                                    console.log(`Executing MCP tool: ${functionName} with args:`, functionArgs);
                                    const result = await this.executeMCPTool(functionName, functionArgs);
                                    console.log('MCP tool execution result:', result);

                                    // Add the function result back to the conversation
                                    contents.push({
                                        role: 'function',
                                        parts: [{
                                            functionResponse: {
                                                name: functionCall.name,
                                                response: result
                                            }
                                        }]
                                    });

                                    // Update status
                                    if (mcpStatusEl) {
                                        mcpStatusEl.textContent = `Completed: ${functionCall.name}`;
                                    }
                                } catch (error) {
                                    console.error('MCP tool execution error:', error);
                                    if (mcpStatusEl) {
                                        mcpStatusEl.textContent = `Error: ${functionCall.name}`;
                                    }
                                }
                            }

                            const content = item.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (content) {
                                updateContent(content);
                            }
                        }
                    } catch (e) {
                        console.log('Failed to parse Google streaming chunk:', line, e);
                        // Continue processing other chunks even if one fails
                    }
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    const parsed = JSON.parse(buffer);
                    const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (content) {
                        updateContent(content);
                    }
                } catch (e) {
                    console.log('Failed to parse final Google buffer:', buffer, e);
                }
            }
        } finally {
            reader.releaseLock();
        }

        await finalizeContent();
        console.log('Google streaming completed');
    }

    async callOllama(message: string): Promise<string> {
        // Build the complete prompt including system message and history
        let prompt = '';

        // Add system message if available
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            prompt += this.buildSystemMessage() + '\n\n';
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            prompt += `${role}: ${msg.content}\n`;
        });

        // Add current message
        prompt += `User: ${message}\nAssistant:`;

        const response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.plugin.settings.model,
                prompt: prompt,
                stream: false,
                options: {
                    temperature: this.plugin.settings.temperature,
                    num_predict: this.plugin.settings.maxTokens
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.response;
    }

    async callLMStudio(message: string): Promise<string> {
        // Build messages array from chat history + current message (same as OpenAI)
        const messages = [];

        // Add system message if available (using buildSystemMessage for consistency)
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            messages.push({ role: 'system', content: this.buildSystemMessage() });
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const response = await fetch(`${this.plugin.settings.lmStudioBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.plugin.settings.model,
                messages: messages,
                max_tokens: this.plugin.settings.maxTokens,
                temperature: this.plugin.settings.temperature
            })
        });

        if (!response.ok) {
            throw new Error(`LM Studio API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async callCustomAPI(message: string): Promise<string> {
        if (!this.plugin.settings.customApiUrl) {
            throw new Error('Please set your custom API URL in settings');
        }

        // Build messages array from chat history + current message (same as OpenAI)
        const messages = [];

        // Add system message if available (using buildSystemMessage for consistency)
        if (this.currentSystemPrompt || this.currentMentalModel || this.contextNotes.length > 0) {
            messages.push({ role: 'system', content: this.buildSystemMessage() });
        }

        // Add chat history
        this.chatHistory.forEach(msg => {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        });

        // Add current message
        messages.push({ role: 'user', content: message });

        const headers: any = {
            'Content-Type': 'application/json',
        };

        if (this.plugin.settings.customApiKey) {
            headers['Authorization'] = `Bearer ${this.plugin.settings.customApiKey}`;
        }

        const response = await fetch(this.plugin.settings.customApiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: this.plugin.settings.model,
                messages: messages,
                max_tokens: this.plugin.settings.maxTokens,
                temperature: this.plugin.settings.temperature
            })
        });

        if (!response.ok) {
            throw new Error(`Custom API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    // Streaming methods for providers without native streaming support
    async streamOllama(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        // Fallback: call regular API and simulate streaming
        const response = await this.callOllama(message);
        const words = response.split(' ');

        for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            updateContent(chunk);
            // Small delay to simulate streaming
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await finalizeContent();
    }

    async streamLMStudio(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        // Fallback: call regular API and simulate streaming
        const response = await this.callLMStudio(message);
        const words = response.split(' ');

        for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            updateContent(chunk);
            // Small delay to simulate streaming
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await finalizeContent();
    }

    async streamCustomAPI(message: string, updateContent: (text: string) => void, finalizeContent: () => Promise<void>) {
        // Fallback: call regular API and simulate streaming
        const response = await this.callCustomAPI(message);
        const words = response.split(' ');

        for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            updateContent(chunk);
            // Small delay to simulate streaming
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await finalizeContent();
    }

    // Fetch available models from each provider with caching
    async fetchAvailableModels(): Promise<string[]> {
        const { provider } = this.plugin.settings;
        const cacheKey = CacheManager.modelListKey(provider);

        // Check cache first
        const cachedModels = this.plugin.cache.get(cacheKey);
        if (cachedModels) {
            this.logger.log(`Using cached models for ${provider}: ${cachedModels.length} models`);
            return cachedModels;
        }

        try {
            let models: string[] = [];
            switch (provider) {
                case 'openai':
                    models = await this.fetchOpenAIModels();
                    break;
                case 'anthropic':
                    models = await this.fetchAnthropicModels();
                    break;
                case 'google':
                    models = await this.fetchGoogleModels();
                    break;
                case 'ollama':
                    models = await this.fetchOllamaModels();
                    break;
                case 'lmstudio':
                    models = await this.fetchLMStudioModels();
                    break;
                case 'openrouter':
                    models = await listOpenRouterModels();
                    break;
                case 'hermes':
                    models = await listHermesModels(this.plugin.settings);
                    break;
                default:
                    return [];
            }

            // Cache the results for 30 minutes
            if (models.length > 0) {
                this.plugin.cache.set(cacheKey, models, 1800000); // 30 minutes
                this.logger.log(`Cached ${models.length} models for ${provider}`);
            }

            return models;
        } catch (error) {
            this.logger.error(`Failed to fetch models for ${provider}:`, error);
            return [];
        }
    }

    async fetchOpenAIModels(): Promise<string[]> {
        if (!this.plugin.settings.openaiApiKey) return [];

        const response = await FetchManager.enhancedFetch('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`
            }
        });

        if (!response.ok) return [];
        const data = await response.json();
        return data.data
            .filter((model: any) => model.id.includes('gpt'))
            .map((model: any) => model.id)
            .sort();
    }

    async fetchAnthropicModels(): Promise<string[]> {
        if (!this.plugin.settings.anthropicApiKey) return [];

        try {
            const response = await FetchManager.enhancedFetch('https://api.anthropic.com/v1/models', {
                headers: {
                    'x-api-key': this.plugin.settings.anthropicApiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            if (!response.ok) {
                console.error('Anthropic API error:', response.status, response.statusText);
                return [];
            }

            const data = await response.json();
            console.log('Anthropic API response:', data);

            if (!data.data) return [];

            // Return the model IDs from the API response
            return data.data.map((model: any) => model.id).sort();
        } catch (error) {
            console.error('Error fetching Anthropic models:', error);
            return [];
        }
    }

    async fetchGoogleModels(): Promise<string[]> {
        if (!this.plugin.settings.googleApiKey) return [];

        try {
            // Use the correct Gemini API models endpoint
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.plugin.settings.googleApiKey}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error('Google API error:', response.status, response.statusText);
                return [];
            }

            const data = await response.json();
            console.log('Google API response:', data);

            if (!data.models) return [];

            // Filter for models that support generateContent and extract clean model names
            return data.models
                .filter((model: any) => {
                    return model.supportedGenerationMethods?.includes('generateContent');
                })
                .map((model: any) => {
                    // Remove 'models/' prefix from model name
                    return model.name.replace('models/', '');
                })
                .sort();
        } catch (error) {
            console.error('Error fetching Google models:', error);
            return [];
        }
    }

    async fetchOllamaModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
            if (!response.ok) return [];

            const data = await response.json();
            return data.models.map((model: any) => model.name);
        } catch {
            return [];
        }
    }

    async fetchLMStudioModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.plugin.settings.lmStudioBaseUrl}/v1/models`);
            if (!response.ok) return [];

            const data = await response.json();
            return data.data.map((model: any) => model.id);
        } catch {
            return [];
        }
    }

    loadConversation(conversationId: string) {
        // Save current conversation first
        this.saveCurrentConversation();

        const conversation = this.plugin.settings.conversations.find(c => c.id === conversationId);
        if (!conversation) return;

        // Update current conversation
        this.currentConversationId = conversationId;
        this.plugin.settings.currentConversationId = conversationId;
        this.plugin.saveSettings();

        // Load conversation data
        this.chatHistory = [...conversation.messages];
        this.conversationNameInput.value = conversation.title;
        this.currentSystemPrompt = conversation.systemPrompt || null;
        this.currentSystemPromptFilename = conversation.systemPromptFilename || null;
        this.currentMentalModel = conversation.mentalModel || null;
        this.currentMentalModelFilename = conversation.mentalModelFilename || null;

        // Clear and rebuild messages UI with pagination
        this.messagesContainer.empty();
        this.initializeMessagePagination(conversation.messages);

        // Update system prompt indicator
        this.updateSystemPromptIndicator();
        // Update mental model indicator
        this.updateMentalModelIndicator();
    }

    loadConversations() {
        // Clean up empty/unnamed conversations on startup
        this.cleanupEmptyConversations();

        // Load current conversation from settings
        const currentId = this.plugin.settings.currentConversationId;
        if (currentId) {
            // Check if the conversation still exists after cleanup
            const exists = this.plugin.settings.conversations.some(c => c.id === currentId);
            if (exists) {
                this.loadConversation(currentId);
            } else {
                // Conversation was cleaned up, start fresh with a backing conversation
                this.startNewConversation();
            }
        } else {
            // No current conversation — create a backing conversation so /name works immediately
            this.startNewConversation();
        }
    }

    initializeMessagePagination(messages: Array<{role: string, content: string, timestamp: number}>) {
        if (!messages || messages.length === 0) return;

        this.totalMessagePages = Math.ceil(messages.length / this.messagePageSize);

        // For long conversations, start from the most recent messages (last page)
        this.currentMessagePage = messages.length > this.messagePageSize ? this.totalMessagePages - 1 : 0;

        this.renderMessagePage(messages);

        // Add scroll listener for infinite scrolling if there are multiple pages
        if (this.totalMessagePages > 1) {
            this.setupInfiniteScrolling(messages);
        }
    }

    renderMessagePage(allMessages: Array<{role: string, content: string, timestamp: number}>) {
        const startIndex = this.currentMessagePage * this.messagePageSize;
        const endIndex = Math.min(startIndex + this.messagePageSize, allMessages.length);
        const pageMessages = allMessages.slice(startIndex, endIndex);

        // Add pagination indicator for older messages
        if (this.currentMessagePage > 0 && !this.messagesContainer.querySelector('.stella-load-older-messages')) {
            const loadOlderBtn = this.messagesContainer.createDiv({
                cls: 'stella-load-older-messages',
                text: `Load ${Math.min(this.messagePageSize, startIndex)} older messages...`
            });

            loadOlderBtn.addEventListener('click', () => {
                if (!this.isLoadingMoreMessages) {
                    this.loadOlderMessages(allMessages);
                }
            });
        }

        // Render the messages
        pageMessages.forEach(msg => {
            this.addMessageToUI(msg.content, msg.role as 'user' | 'assistant' | 'error');
        });

        // Auto-scroll to bottom for new conversations or when viewing latest page
        if (this.currentMessagePage === this.totalMessagePages - 1) {
            setTimeout(() => {
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            }, 100);
        }
    }

    async loadOlderMessages(allMessages: Array<{role: string, content: string, timestamp: number}>) {
        if (this.isLoadingMoreMessages || this.currentMessagePage <= 0) return;

        this.isLoadingMoreMessages = true;
        const loadBtn = this.messagesContainer.querySelector('.stella-load-older-messages') as HTMLElement;

        if (loadBtn) {
            loadBtn.textContent = 'Loading older messages...';
            loadBtn.classList.add('loading');
        }

        // Simulate loading delay for better UX
        await new Promise(resolve => setTimeout(resolve, 300));

        // Get current scroll position to maintain it
        const scrollHeight = this.messagesContainer.scrollHeight;
        const scrollTop = this.messagesContainer.scrollTop;

        // Load previous page
        this.currentMessagePage--;
        const startIndex = this.currentMessagePage * this.messagePageSize;
        const endIndex = startIndex + this.messagePageSize;
        const olderMessages = allMessages.slice(startIndex, endIndex);

        // Remove the load button temporarily
        if (loadBtn) {
            loadBtn.remove();
        }

        // Prepend older messages
        const tempContainer = document.createElement('div');
        olderMessages.forEach(msg => {
            const messageEl = document.createElement('div');
            messageEl.className = `stella-message stella-message-${msg.role}`;

            const contentEl = document.createElement('div');
            contentEl.className = 'stella-message-content';
            contentEl.textContent = msg.content;
            messageEl.appendChild(contentEl);

            tempContainer.appendChild(messageEl);
        });

        // Add new load button if there are more pages
        if (this.currentMessagePage > 0) {
            const newLoadBtn = document.createElement('div');
            newLoadBtn.className = 'stella-load-older-messages';
            newLoadBtn.textContent = `Load ${Math.min(this.messagePageSize, startIndex)} older messages...`;
            newLoadBtn.addEventListener('click', () => {
                if (!this.isLoadingMoreMessages) {
                    this.loadOlderMessages(allMessages);
                }
            });
            tempContainer.insertBefore(newLoadBtn, tempContainer.firstChild);
        }

        // Insert at the beginning
        while (tempContainer.firstChild) {
            this.messagesContainer.insertBefore(tempContainer.firstChild, this.messagesContainer.firstChild);
        }

        // Restore scroll position
        const newScrollHeight = this.messagesContainer.scrollHeight;
        const scrollDiff = newScrollHeight - scrollHeight;
        this.messagesContainer.scrollTop = scrollTop + scrollDiff;

        this.isLoadingMoreMessages = false;
    }

    setupInfiniteScrolling(allMessages: Array<{role: string, content: string, timestamp: number}>) {
        let scrollTimeout: NodeJS.Timeout;

        this.messagesContainer.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                const scrollTop = this.messagesContainer.scrollTop;

                // Load older messages when scrolled near top
                if (scrollTop < 100 && this.currentMessagePage > 0 && !this.isLoadingMoreMessages) {
                    this.loadOlderMessages(allMessages);
                }
            }, 150); // Debounce scroll events
        });
    }

    switchConversation(conversationId: string) {
        // Placeholder for conversation switching
        if (conversationId === 'new') {
            this.startNewConversation();
        }
    }

    async deleteCurrentConversationAndStartNew() {
        // Delete current conversation if it exists
        if (this.currentConversationId) {
            await this.deleteConversation(this.currentConversationId);
        } else {
            // If no current conversation, just start new one
            this.startNewConversation();
        }
    }

    startNewConversation() {
        // Clean up current conversation if it's empty/unnamed before starting new one
        if (this.currentConversationId) {
            this.cleanupIfEmpty(this.currentConversationId);
        }

        // Create new conversation with date title using local time
        const now = new Date();
        const localDateStr = now.toLocaleDateString('en-CA'); // Format: YYYY-MM-DD in local time
        const dateTitle = localDateStr;

        const newConversation: Conversation = {
            id: `conv_${Date.now()}`,
            title: dateTitle,
            messages: [],
            createdAt: now.getTime(),
            updatedAt: now.getTime()
        };

        // Add to plugin settings (but don't persist yet - will save when named or has messages)
        this.plugin.settings.conversations.unshift(newConversation);
        this.plugin.settings.currentConversationId = newConversation.id;
        this.currentConversationId = newConversation.id;

        // Update UI
        this.messagesContainer.empty();
        this.chatHistory = [];
        this.currentSystemPrompt = null;
        this.currentSystemPromptFilename = null;
        this.currentMentalModel = null;
        this.currentMentalModelFilename = null;
        this.conversationNameInput.value = dateTitle;

        // Refresh the input-area indicators so cleared state (system prompt,
        // mental model) doesn't leave stale icons hanging into the new chat.
        // Each update no-ops if its element doesn't exist yet.
        this.updateSystemPromptIndicator();
        this.updateMentalModelIndicator();
        this.updateMCPIndicator();
        this.updateNoteIndicator();
    }

    // Check if conversation title is a default date format (YYYY-MM-DD)
    private isDefaultDateTitle(title: string): boolean {
        return /^\d{4}-\d{2}-\d{2}$/.test(title);
    }

    // Check if a conversation is worth saving (has custom name or has messages)
    private isWorthSaving(conversation: Conversation): boolean {
        const hasCustomName = !this.isDefaultDateTitle(conversation.title);
        const hasMessages = conversation.messages && conversation.messages.length > 0;
        return hasCustomName || hasMessages;
    }

    // Clean up a conversation if it's empty and unnamed
    private cleanupIfEmpty(conversationId: string) {
        const conversation = this.plugin.settings.conversations.find(c => c.id === conversationId);
        if (conversation && !this.isWorthSaving(conversation)) {
            // Remove empty/unnamed conversation
            this.plugin.settings.conversations = this.plugin.settings.conversations.filter(c => c.id !== conversationId);
            console.log(`Cleaned up empty conversation: ${conversationId}`);
        }
    }

    // Clean up all empty/unnamed conversations (call periodically)
    private cleanupEmptyConversations() {
        const before = this.plugin.settings.conversations.length;
        this.plugin.settings.conversations = this.plugin.settings.conversations.filter(c => this.isWorthSaving(c));
        const removed = before - this.plugin.settings.conversations.length;
        if (removed > 0) {
            console.log(`Cleaned up ${removed} empty/unnamed conversations`);
            this.plugin.saveSettings();
        }
    }

    saveConversationName() {
        if (!this.currentConversationId) return;

        const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
        if (conversation) {
            conversation.title = this.conversationNameInput.value;
            conversation.updatedAt = Date.now();
            // Save immediately when user names a conversation (makes it worth saving)
            this.plugin.saveSettings();
            console.log(`Conversation named: ${conversation.title}`);
        }
    }

    saveCurrentConversation() {
        if (!this.currentConversationId) return;

        const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
        if (conversation) {
            conversation.messages = [...this.chatHistory];
            conversation.updatedAt = Date.now();

            // Only persist if conversation is worth saving (has name or messages)
            if (this.isWorthSaving(conversation)) {
                this.plugin.saveSettings();
                // Update conversation metadata cache
                this.updateConversationMetadataCache();
            }
        }
    }

    private updateConversationMetadataCache() {
        const metadata = this.plugin.settings.conversations.map(conv => ({
            id: conv.id,
            title: conv.title,
            messageCount: conv.messages.length,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            hasSystemPrompt: !!conv.systemPrompt,
            hasMentalModel: !!conv.mentalModel
        }));

        // Cache metadata for 5 minutes
        this.plugin.cache.set(CacheManager.conversationMetaKey(), metadata, 300000);
        this.logger.log(`Updated conversation metadata cache: ${metadata.length} conversations`);
    }

    async deleteConversation(conversationId: string) {
        // Remove the conversation from settings
        this.plugin.settings.conversations = this.plugin.settings.conversations.filter(
            conv => conv.id !== conversationId
        );

        // If we're deleting the current conversation, switch to a new one
        if (this.currentConversationId === conversationId) {
            this.startNewConversation();
        }

        // Save settings and invalidate cache
        await this.plugin.saveSettings();
        this.plugin.cache.invalidateConversationData();
    }

    showChatHistory() {
        // Save current conversation first
        this.saveCurrentConversation();

        const modal = new ConversationHistoryModal(
            this.app,
            {
                conversations: this.plugin.settings.conversations,
                currentConversationId: this.currentConversationId
            },
            {
                onSelect: (conversationId: string) => {
                    this.loadConversation(conversationId);
                },
                onDelete: async (conversationId: string) => {
                    await this.deleteConversation(conversationId);
                }
            }
        );
        modal.open();
    }

    async showSystemPromptSelector() {
        const promptsPath = this.plugin.settings.systemPromptsPath;

        if (!promptsPath) {
            new Notice('System prompts directory not configured. Please set it in plugin settings.');
            return;
        }

        const modal = createSystemPromptModal(
            this.app,
            promptsPath,
            {
                onSelect: async (filePath: string, _filename: string) => {
                    await this.loadSystemPrompt(filePath);
                },
                onClose: () => {
                    setTimeout(() => this.chatInput.focus(), 100);
                }
            }
        );
        modal.open();
    }

    async loadSystemPrompt(filepath: string) {
        try {
            const file = this.app.vault.getAbstractFileByPath(filepath);
            if (!file || !(file instanceof TFile)) {
                this.addMessage(`System prompt file not found: ${filepath}`, 'error');
                return;
            }
            const content = await this.app.vault.cachedRead(file);
            const filename = file.basename;

            // Set the system prompt for current conversation
            this.currentSystemPrompt = content;
            this.currentSystemPromptFilename = filename;
            console.log('System prompt loaded:', filename);

            // Save to current conversation
            if (this.currentConversationId) {
                const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
                if (conversation) {
                    conversation.systemPrompt = content;
                    conversation.systemPromptFilename = filename;
                    conversation.updatedAt = Date.now();
                    this.plugin.saveSettings();
                    console.log('System prompt saved to conversation:', filename);
                }
            }

            // Update the system prompt indicator
            this.updateSystemPromptIndicator();

        } catch (error) {
            this.addMessage(`Error loading system prompt: ${error.message}`, 'error');
        }
    }

    unloadSystemPrompt() {
        // Clear the current system prompt
        this.currentSystemPrompt = null;
        this.currentSystemPromptFilename = null;
        console.log('System prompt unloaded');

        // Remove from current conversation
        if (this.currentConversationId) {
            const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
            if (conversation) {
                conversation.systemPrompt = undefined;
                conversation.systemPromptFilename = undefined;
                conversation.updatedAt = Date.now();
                this.plugin.saveSettings();
                console.log('System prompt removed from conversation');
            }
        }

        // Update the indicator
        this.updateSystemPromptIndicator();
    }

    async showNoteSelector() {
        const modal = new NoteSelectorModal(
            this.app,
            {
                onSelect: (filename: string, content: string) => {
                    // Add to context notes directly (content already read by modal)
                    this.contextNotes.push({ name: filename, content });
                    this.updateContextIndicator();
                    console.log(`Added note context: ${filename}`);
                },
                onClose: () => {
                    // Focus handled by modal
                }
            }
        );
        modal.open();
    }

    async addNoteContext(file: any) {
        try {
            // Read file content
            const content = await this.app.vault.read(file);

            // Add to context notes
            this.contextNotes.push({
                name: file.basename,
                content: content
            });

            // Update the context indicator
            this.updateContextIndicator();

            console.log(`Added note context: ${file.basename}`);

        } catch (error) {
            this.addMessage(`Error reading note: ${error.message}`, 'error');
        }
    }

    removeNoteContext(index: number) {
        if (index >= 0 && index < this.contextNotes.length) {
            const removed = this.contextNotes.splice(index, 1)[0];
            this.updateContextIndicator();
            console.log(`Removed note context: ${removed.name}`);
        }
    }

    showNoteContextManager() {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Manage Note Context');

        const container = modal.contentEl.createDiv({ cls: 'stella-note-manager-container' });

        if (this.contextNotes.length === 0) {
            container.createEl('p', { text: 'No notes are currently loaded in context.' });

            const addButton = container.createEl('button', {
                text: 'Add Notes',
                cls: 'mod-cta'
            });
            addButton.addEventListener('click', () => {
                modal.close();
                this.showNoteSelector();
            });
        } else {
            container.createEl('p', { text: `${this.contextNotes.length} note(s) loaded in context:` });

            const notesList = container.createEl('div', { cls: 'stella-notes-manager-list' });

            this.contextNotes.forEach((note, index) => {
                const noteItem = notesList.createDiv({ cls: 'stella-note-manager-item' });

                const noteName = noteItem.createEl('span', {
                    text: note.name,
                    cls: 'stella-note-name'
                });

                const removeButton = noteItem.createEl('button', {
                    text: '×',
                    cls: 'stella-note-remove-btn'
                });

                removeButton.addEventListener('click', () => {
                    this.removeNoteContext(index);
                    modal.close();
                });
            });

            const buttonContainer = container.createEl('div', { cls: 'stella-note-manager-buttons' });

            const addMoreButton = buttonContainer.createEl('button', {
                text: 'Add More Notes',
                cls: 'mod-secondary'
            });
            addMoreButton.addEventListener('click', () => {
                modal.close();
                this.showNoteSelector();
            });

            const clearAllButton = buttonContainer.createEl('button', {
                text: 'Clear All',
                cls: 'mod-warning'
            });
            clearAllButton.addEventListener('click', () => {
                this.contextNotes = [];
                this.updateContextIndicator();
                modal.close();
            });
        }

        modal.open();
    }

    showHelpMessage() {
        // Generate help text as a clean monospaced list
        const helpText = 'Available Commands:\n\n' +
            this.availableCommands
                .map(cmd => `${cmd.command.padEnd(12)} - ${cmd.description}`)
                .join('\n');

        // Add message with monospace styling
        const messageEl = this.addMessage(helpText, 'system');

        // Apply monospace styling to the content
        const contentEl = messageEl.querySelector('.stella-message-content') as HTMLElement;
        if (contentEl) {
            contentEl.style.fontFamily = 'var(--font-monospace)';
            contentEl.style.whiteSpace = 'pre-line';
            contentEl.style.backgroundColor = 'var(--background-secondary)';
            contentEl.style.padding = '12px';
            contentEl.style.borderRadius = '4px';
            contentEl.style.fontSize = '13px';
        }
    }

    updateContextIndicator() {
        // Hide the old chip-based context indicator
        if (this.contextIndicator) {
            this.contextIndicator.style.display = 'none';
        }

        // Update the new note icon indicator
        this.updateNoteIndicator();
    }

    updateNoteIndicator() {
        if (!this.noteIndicator) return;

        // Clear any existing event listeners by cloning the element
        const newNoteIndicator = this.noteIndicator.cloneNode(true) as HTMLElement;
        this.noteIndicator.parentNode?.replaceChild(newNoteIndicator, this.noteIndicator);
        this.noteIndicator = newNoteIndicator;

        if (this.contextNotes.length > 0) {
            // Use page icon from Lucide
            this.noteIndicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>';
            this.noteIndicator.style.display = 'block';

            // Add click functionality to manage notes
            this.noteIndicator.addEventListener('click', (e) => {
                e.preventDefault();
                this.showNoteContextManager();
            });

            // Create hover tooltip showing list of loaded notes
            let tooltipElement: HTMLElement | null = null;

            this.noteIndicator.addEventListener('mouseenter', (e) => {
                // Remove any existing tooltip
                if (tooltipElement) {
                    tooltipElement.remove();
                }

                // Create tooltip with bulleted list of notes
                const notesList = this.contextNotes.map(note => `• ${note.name}`).join('\n');
                const tooltipText = `Loaded notes:\n${notesList}`;

                tooltipElement = document.body.createEl('div', {
                    cls: 'stella-tooltip',
                    text: tooltipText
                });

                // Position tooltip above the icon
                const rect = this.noteIndicator.getBoundingClientRect();
                const tooltipRect = tooltipElement.getBoundingClientRect();
                const left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
                const top = rect.top - tooltipRect.height - 10;

                tooltipElement.style.position = 'fixed';
                tooltipElement.style.left = `${Math.max(10, left)}px`;
                tooltipElement.style.top = `${Math.max(10, top)}px`;
                tooltipElement.style.zIndex = '10000';
            });

            this.noteIndicator.addEventListener('mouseleave', () => {
                if (tooltipElement) {
                    tooltipElement.remove();
                    tooltipElement = null;
                }
            });
        } else {
            this.noteIndicator.innerHTML = '';
            this.noteIndicator.style.display = 'none';
        }

        // Update positioning for all indicators
        this.updateIndicatorPositions();
    }

    buildSystemMessage(): string {
        let systemMessage = '';

        // Add system prompt if available
        if (this.currentSystemPrompt) {
            systemMessage += this.currentSystemPrompt;
        }

        // Add mental model if available
        if (this.currentMentalModel) {
            if (systemMessage) {
                systemMessage += '\n\n';
            }
            systemMessage += `## Active Mental Model: ${this.currentMentalModelFilename || 'Mental Model'}\n\n`;
            systemMessage += 'The following is your active reasoning lens. Apply this framework to evaluate, analyze, and filter your responses. Do not merely reference it — actively think through it when forming your answers.\n\n';
            systemMessage += this.currentMentalModel;
        }

        // Add context notes if available
        if (this.contextNotes.length > 0) {
            if (systemMessage) {
                systemMessage += '\n\n';
            }

            systemMessage += 'Here are reference notes that may be relevant to the conversation:\n\n';
            systemMessage += this.contextNotes.map(note =>
                `=== Note: ${note.name} ===\n${note.content}\n`
            ).join('\n');
        }

        // Add MCP tools information if available with comprehensive error handling
        try {
            if (this.activeMCPServers && Array.isArray(this.activeMCPServers) && this.activeMCPServers.length > 0) {
                console.log('buildSystemMessage: Adding MCP tools to system message', this.activeMCPServers);

                if (systemMessage) {
                    systemMessage += '\n\n';
                }

                systemMessage += 'You have access to the following MCP (Model Context Protocol) tools through Google\'s function calling system:\n\n';

                let totalToolCount = 0;
                for (const serverInfo of this.activeMCPServers) {
                    try {
                        if (!serverInfo) {
                            console.warn('buildSystemMessage: Skipping null/undefined server');
                            continue;
                        }

                        console.log(`buildSystemMessage: Processing server ${serverInfo.name || 'unknown'}`, serverInfo);

                        const tools = Array.isArray(serverInfo.tools) ? serverInfo.tools : [];
                        const prompts = Array.isArray(serverInfo.prompts) ? serverInfo.prompts : [];
                        const highlighted = Array.isArray(serverInfo.highlightedTools) ? serverInfo.highlightedTools : [];
                        totalToolCount += tools.length;

                        if (tools.length > 0) {
                            systemMessage += `=== ${serverInfo.name} Server Tools ===\n`;
                            for (const tool of tools) {
                                try {
                                    if (tool && tool.name) {
                                        const functionName = `${serverInfo.name}_${tool.name}`;
                                        const isHighlighted = highlighted.includes(tool.name);

                                        if (isHighlighted) {
                                            systemMessage += `• **PREFERRED** Function: ${functionName}`;
                                            if (tool.description) {
                                                systemMessage += ` - ${tool.description}`;
                                            }
                                            systemMessage += '\n  (User explicitly selected this tool - use it when relevant)\n';
                                        } else {
                                            systemMessage += `• Function: ${functionName}`;
                                            if (tool.description) {
                                                systemMessage += ` - ${tool.description}`;
                                            }
                                            systemMessage += '\n';
                                        }

                                        // Add input schema information if available
                                        if (tool.inputSchema && tool.inputSchema.properties) {
                                            const properties = Object.keys(tool.inputSchema.properties);
                                            if (properties.length > 0) {
                                                systemMessage += `  Parameters: ${properties.join(', ')}\n`;
                                            }
                                        }
                                    }
                                } catch (toolError) {
                                    console.error('Error processing tool:', tool, toolError);
                                }
                            }
                            systemMessage += '\n';
                        }

                        if (prompts.length > 0) {
                            systemMessage += `=== ${serverInfo.name} Server Prompts ===\n`;
                            for (const prompt of prompts) {
                                try {
                                    if (prompt && prompt.name) {
                                        systemMessage += `• ${prompt.name}`;
                                        if (prompt.description) {
                                            systemMessage += ` - ${prompt.description}`;
                                        }
                                        systemMessage += '\n';
                                    }
                                } catch (promptError) {
                                    console.error('Error processing prompt:', prompt, promptError);
                                }
                            }
                            systemMessage += '\n';
                        }
                    } catch (serverError) {
                        console.error(`buildSystemMessage: Error processing server ${serverInfo?.name || 'unknown'}:`, serverError);
                        // Continue processing other servers
                        systemMessage += `=== ${serverInfo?.name || 'Unknown Server'} Server ===\n(Error loading tools/prompts)\n\n`;
                    }
                }

                if (totalToolCount > 3) {
                    systemMessage += '\n**DISAMBIGUATION**: If the user\'s request could apply to multiple tools, ask for clarification about which specific tool or action they want before proceeding.\n';
                }

                systemMessage += '\nIMPORTANT: You can call these functions directly using Google\'s function calling capability. When you need to use a tool, call the corresponding function and I will automatically execute it and return the results to you. Do not ask the user to run tools - call them directly when needed.';

                console.log('buildSystemMessage: Final system message with MCP info:', systemMessage);
            }
        } catch (mcpError) {
            console.error('buildSystemMessage: Error processing MCP servers:', mcpError, this.activeMCPServers);
            // Add basic MCP error info to system message instead of crashing
            if (systemMessage) systemMessage += '\n\n';
            systemMessage += '=== MCP Integration ===\n(Error loading MCP server information)\n\n';
        }

        return systemMessage;
    }

    openSettings() {
        // Open plugin settings
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById('stella-mcp');
    }

    updateModelInfo(container: HTMLElement) {
        const { provider, model } = this.plugin.settings;
        const providerName = provider === 'anthropic' ? 'claude' :
                            provider === 'openai' ? 'openai' :
                            provider === 'google' ? 'google' :
                            provider === 'ollama' ? 'ollama' :
                            provider === 'lmstudio' ? 'lm-studio' :
                            provider === 'openrouter' ? 'openrouter' :
                            provider === 'openclaw' ? 'openclaw' :
                            provider === 'hermes' ? 'hermes' : 'custom';

        if (!model || model.trim() === '') {
            container.textContent = `${providerName}: no model selected`;
        } else {
            container.textContent = `${providerName}: ${model}`;
        }
    }

    updateSystemPromptIndicator() {
        if (!this.systemPromptIndicator) return;

        if (this.currentSystemPrompt) {
            // Use square-terminal icon instead of text
            this.systemPromptIndicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M7 7l4 4-4 4"></path><path d="M13 15h4"></path></svg>';
            this.systemPromptIndicator.style.display = 'block';

            // Use the filename for tooltip, fallback to generic name
            const promptName = this.currentSystemPromptFilename || 'System Prompt';
            this.systemPromptIndicator.setAttribute('title', promptName);
        } else {
            this.systemPromptIndicator.innerHTML = '';
            this.systemPromptIndicator.style.display = 'none';
        }

        // Update positioning for both indicators
        this.updateIndicatorPositions();
    }

    updateMentalModelIndicator() {
        if (!this.mentalModelIndicator) return;

        if (this.currentMentalModel) {
            // Use eclipse icon
            this.mentalModelIndicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 1 0 10 10"/></svg>';
            this.mentalModelIndicator.style.display = 'block';

            // Use the filename for tooltip, fallback to generic name
            const modelName = this.currentMentalModelFilename || 'Mental Model';
            this.mentalModelIndicator.setAttribute('title', modelName);
        } else {
            this.mentalModelIndicator.innerHTML = '';
            this.mentalModelIndicator.style.display = 'none';
        }

        // Update positioning for both indicators
        this.updateIndicatorPositions();
    }

    updateIndicatorPositions() {
        if (!this.systemPromptIndicator || !this.mentalModelIndicator || !this.mcpIndicator || !this.noteIndicator) return;

        const hasSystemPrompt = this.currentSystemPrompt !== null;
        const hasMentalModel = this.currentMentalModel !== null;
        const hasMCP = this.activeMCPServers && this.activeMCPServers.length > 0;
        const hasNotes = this.contextNotes.length > 0;

        // Reset all positions first
        this.systemPromptIndicator.style.right = '';
        this.mentalModelIndicator.style.right = '';
        this.mcpIndicator.style.right = '';
        this.noteIndicator.style.right = '';

        // Count active indicators and position them from right to left
        const activeIndicators = [];
        if (hasSystemPrompt) activeIndicators.push('system');
        if (hasMentalModel) activeIndicators.push('mental');
        if (hasMCP) activeIndicators.push('mcp');
        if (hasNotes) activeIndicators.push('note');

        // Position from right to left: 16px, 48px, 80px, 112px
        activeIndicators.forEach((type, index) => {
            const rightPosition = 16 + (index * 32); // 32px spacing between indicators

            if (type === 'system') {
                this.systemPromptIndicator.style.right = `${rightPosition}px`;
            } else if (type === 'mental') {
                this.mentalModelIndicator.style.right = `${rightPosition}px`;
            } else if (type === 'mcp') {
                this.mcpIndicator.style.right = `${rightPosition}px`;
            } else if (type === 'note') {
                this.noteIndicator.style.right = `${rightPosition}px`;
            }
        });
    }

    async showMentalModelSelector() {
        const modelsPath = this.plugin.settings.mentalModelsPath;

        if (!modelsPath) {
            new Notice('Mental models directory not configured. Please set it in plugin settings.');
            return;
        }

        const modal = createMentalModelModal(
            this.app,
            modelsPath,
            {
                onSelect: async (filePath: string, _filename: string) => {
                    await this.loadMentalModel(filePath);
                },
                onClose: () => {
                    setTimeout(() => this.chatInput.focus(), 100);
                }
            }
        );
        modal.open();
    }

    async loadMentalModel(filepath: string) {
        try {
            const file = this.app.vault.getAbstractFileByPath(filepath);
            if (!file || !(file instanceof TFile)) {
                this.addMessage(`Mental model file not found: ${filepath}`, 'error');
                return;
            }
            const content = await this.app.vault.cachedRead(file);
            const filename = file.basename;

            this.currentMentalModel = content;
            this.currentMentalModelFilename = filename;
            console.log('Mental model loaded:', filename);

            if (this.currentConversationId) {
                const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
                if (conversation) {
                    conversation.mentalModel = content;
                    conversation.mentalModelFilename = filename;
                    conversation.updatedAt = Date.now();
                    this.plugin.saveSettings();
                    console.log('Mental model saved to conversation:', filename);
                }
            }

            this.updateMentalModelIndicator();
        } catch (error) {
            this.addMessage(`Error loading mental model: ${error.message}`, 'error');
        }
    }

    unloadMentalModel() {
        this.currentMentalModel = null;
        this.currentMentalModelFilename = null;
        console.log('Mental model unloaded');

        if (this.currentConversationId) {
            const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
            if (conversation) {
                conversation.mentalModel = undefined;
                conversation.mentalModelFilename = undefined;
                conversation.updatedAt = Date.now();
                this.plugin.saveSettings();
                console.log('Mental model removed from conversation');
            }
        }

        this.updateMentalModelIndicator();
    }

    async showMCPSelector() {
        const modal = new Modal(this.app);
        modal.titleEl.setText('MCP Servers');
        modal.modalEl.style.width = '70vw';
        modal.modalEl.style.height = '70vh';
        modal.modalEl.style.maxWidth = '1000px';
        modal.modalEl.style.minWidth = '600px';

        const contentEl = modal.contentEl;
        contentEl.empty();
        modal.open();

        try {
            // Get MCP client manager
            const mcpManager = this.plugin.mcpClientManager;

            // Get servers from both manager AND settings (in case init is still running)
            let servers: MCPServer[] = [];
            if (mcpManager) {
                servers = Array.from(mcpManager.getServers().values()) as MCPServer[];
            }

            // Also check settings for configured servers not yet in manager
            const configuredServers = this.plugin.settings.mcpServers || [];
            console.log(`MCP Modal: Found ${servers.length} in manager, ${configuredServers.length} in settings`);

            // If no servers anywhere, show add form
            if (servers.length === 0 && configuredServers.length === 0) {
                this.showAddServerForm(contentEl, modal);
                return;
            }

            // If servers in settings but not in manager, try to add them
            if (servers.length === 0 && configuredServers.length > 0 && mcpManager) {
                contentEl.createEl('p', { text: 'Connecting to configured servers...' });
                for (const serverConfig of configuredServers) {
                    try {
                        await mcpManager.addServer(serverConfig);
                    } catch (e) {
                        console.error(`Failed to add server ${serverConfig.name}:`, e);
                    }
                }
                servers = Array.from(mcpManager.getServers().values()) as MCPServer[];
                contentEl.empty();
            }

            // Still no servers after trying to connect?
            if (servers.length === 0) {
                this.showAddServerForm(contentEl, modal);
                return;
            }

            // Refresh tools/prompts in background (don't block UI)
            for (const server of servers) {
                if (server.connected && mcpManager) {
                    mcpManager.refreshServerTools(server.id).catch(() => {});
                    mcpManager.refreshServerPrompts(server.id).catch(() => {});
                }
            }

            // Create simple two-panel layout
            const mainContainer = contentEl.createDiv();
            mainContainer.style.display = 'flex';
            mainContainer.style.height = '100%';
            mainContainer.style.gap = '16px';

            const leftPanel = mainContainer.createDiv();
            leftPanel.style.width = '40%';
            leftPanel.style.borderRight = '1px solid var(--background-modifier-border)';
            leftPanel.style.paddingRight = '16px';

            const rightPanel = mainContainer.createDiv();
            rightPanel.style.width = '60%';

            const serverList = leftPanel.createDiv();
            serverList.style.maxHeight = 'calc(70vh - 100px)';
            serverList.style.overflowY = 'auto';

            const previewContent = rightPanel.createDiv();
            previewContent.style.maxHeight = 'calc(70vh - 100px)';
            previewContent.style.overflowY = 'auto';
            previewContent.textContent = 'Select a server to view tools & prompts';

            let selectedIndex = 0;

            // Store server items for navigation
            const mcpServerItems: HTMLElement[] = [];

            // Add servers to list
            servers.forEach((server, index) => {
                const serverItem = serverList.createDiv();
                serverItem.style.padding = '12px';
                serverItem.style.marginBottom = '8px';
                serverItem.style.cursor = 'pointer';
                serverItem.style.borderRadius = '4px';
                serverItem.style.border = '1px solid transparent';
                serverItem.style.backgroundColor = 'var(--background-secondary)';

                const isActive = this.activeMCPServers?.some(s => s.name === server.name);

                if (index === 0) {
                    serverItem.style.backgroundColor = 'var(--background-modifier-hover)';
                    serverItem.style.border = '1px solid var(--accent-color)';
                    serverItem.classList.add('selected');
                }

                if (isActive) {
                    serverItem.style.borderLeft = '3px solid var(--interactive-accent)';
                }

                // Toggle container with name and switch
                const toggleContainer = serverItem.createDiv();
                toggleContainer.style.display = 'flex';
                toggleContainer.style.justifyContent = 'space-between';
                toggleContainer.style.alignItems = 'center';
                toggleContainer.style.marginBottom = '4px';

                const nameEl = toggleContainer.createDiv();
                nameEl.textContent = server.name;
                nameEl.style.fontWeight = '500';

                // Toggle switch
                const toggleSwitch = toggleContainer.createEl('div');
                toggleSwitch.className = 'stella-mcp-toggle';
                toggleSwitch.style.cssText = `
                    width: 40px; height: 22px;
                    background: ${isActive ? 'var(--interactive-accent)' : 'var(--background-modifier-border)'};
                    border-radius: 11px; cursor: pointer; position: relative;
                    transition: background 0.2s ease; flex-shrink: 0;
                `;

                const toggleKnob = toggleSwitch.createEl('div');
                toggleKnob.style.cssText = `
                    width: 18px; height: 18px;
                    background: white; border-radius: 50%;
                    position: absolute; top: 2px;
                    left: ${isActive ? '20px' : '2px'};
                    transition: left 0.2s ease;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                `;

                toggleSwitch.onclick = (e) => {
                    e.stopPropagation();
                    const newState = this.toggleMCPServer(server);
                    toggleSwitch.style.background = newState ? 'var(--interactive-accent)' : 'var(--background-modifier-border)';
                    toggleKnob.style.left = newState ? '20px' : '2px';
                    serverItem.style.borderLeft = newState ? '3px solid var(--interactive-accent)' : 'none';
                };

                const statusEl = serverItem.createDiv();
                statusEl.textContent = server.connected ? 'Connected' : 'Disconnected';
                statusEl.style.fontSize = '12px';
                statusEl.style.color = server.connected ? 'var(--text-success)' : 'var(--text-error)';

                // Add to mcpServerItems array for keyboard navigation
                mcpServerItems.push(serverItem);

                serverItem.onclick = () => {
                    // Update selection
                    mcpServerItems.forEach((el, i) => {
                        el.style.backgroundColor = 'var(--background-secondary)';
                        el.style.border = '1px solid transparent';
                        el.classList.remove('selected');
                        // Preserve active indicator
                        if (this.activeMCPServers?.some(s => s.name === servers[i]?.name)) {
                            el.style.borderLeft = '3px solid var(--interactive-accent)';
                        }
                    });
                    serverItem.style.backgroundColor = 'var(--background-modifier-hover)';
                    serverItem.style.border = '1px solid var(--accent-color)';
                    if (isActive || this.activeMCPServers?.some(s => s.name === server.name)) {
                        serverItem.style.borderLeft = '3px solid var(--interactive-accent)';
                    }
                    serverItem.classList.add('selected');
                    selectedIndex = index;

                    showPreview(server);
                };
            });

            // Add "Add Server" button at bottom of server list
            const addServerBtn = serverList.createDiv();
            addServerBtn.style.padding = '12px';
            addServerBtn.style.marginTop = '8px';
            addServerBtn.style.cursor = 'pointer';
            addServerBtn.style.borderRadius = '4px';
            addServerBtn.style.border = '1px dashed var(--background-modifier-border)';
            addServerBtn.style.textAlign = 'center';
            addServerBtn.style.color = 'var(--text-muted)';
            addServerBtn.textContent = '+ Add Server';

            addServerBtn.addEventListener('mouseenter', () => {
                addServerBtn.style.backgroundColor = 'var(--background-modifier-hover)';
                addServerBtn.style.color = 'var(--text-normal)';
            });
            addServerBtn.addEventListener('mouseleave', () => {
                addServerBtn.style.backgroundColor = 'transparent';
                addServerBtn.style.color = 'var(--text-muted)';
            });

            addServerBtn.onclick = () => {
                this.showAddServerForm(contentEl, modal);
            };

            // Preview function
            const showPreview = async (server: MCPServer) => {
                previewContent.innerHTML = '';

                // Server header
                const header = previewContent.createDiv();
                header.style.marginBottom = '16px';

                const title = header.createEl('h3');
                title.textContent = server.name;
                title.style.margin = '0 0 8px 0';

                const status = header.createDiv();
                status.textContent = server.connected ? 'Connected' : 'Disconnected';
                status.style.color = server.connected ? 'var(--text-success)' : 'var(--text-error)';
                status.style.fontSize = '14px';

                // Get tools and prompts
                const tools = mcpManager.getTools().get(server.id) || [];
                const prompts = mcpManager.getPrompts().get(server.id) || [];

                // Show tools
                if (tools.length > 0) {
                    const toolsSection = previewContent.createDiv();
                    toolsSection.style.marginBottom = '16px';

                    const toolsTitle = toolsSection.createEl('h4');
                    toolsTitle.textContent = `Tools (${tools.length})`;
                    toolsTitle.style.margin = '0 0 8px 0';
                    toolsTitle.style.fontSize = '16px';

                    tools.forEach(tool => {
                        const toolItem = toolsSection.createDiv();
                        toolItem.style.padding = '8px';
                        toolItem.style.marginBottom = '4px';
                        toolItem.style.backgroundColor = 'var(--background-secondary)';
                        toolItem.style.borderRadius = '4px';
                        toolItem.style.cursor = 'pointer';
                        toolItem.style.border = '1px solid transparent';

                        toolItem.addEventListener('mouseenter', () => {
                            toolItem.style.backgroundColor = 'var(--background-modifier-hover)';
                            toolItem.style.border = '1px solid var(--accent-color)';
                        });
                        toolItem.addEventListener('mouseleave', () => {
                            toolItem.style.backgroundColor = 'var(--background-secondary)';
                            toolItem.style.border = '1px solid transparent';
                        });

                        const toolName = toolItem.createDiv();
                        toolName.textContent = tool.name;
                        toolName.style.fontWeight = '500';

                        if (tool.description) {
                            const desc = toolItem.createDiv();
                            desc.textContent = tool.description;
                            desc.style.fontSize = '12px';
                            desc.style.color = 'var(--text-muted)';
                            desc.style.marginTop = '4px';
                        }

                        toolItem.onclick = () => {
                            this.activateMCPTool(server.name, tool);
                            modal.close();
                            setTimeout(() => this.chatInput.focus(), 100);
                        };
                    });
                }

                // Show prompts
                if (prompts.length > 0) {
                    const promptsSection = previewContent.createDiv();

                    const promptsTitle = promptsSection.createEl('h4');
                    promptsTitle.textContent = `Prompts (${prompts.length})`;
                    promptsTitle.style.margin = '0 0 8px 0';
                    promptsTitle.style.fontSize = '16px';

                    prompts.forEach(prompt => {
                        const promptItem = promptsSection.createDiv();
                        promptItem.style.padding = '8px';
                        promptItem.style.marginBottom = '4px';
                        promptItem.style.backgroundColor = 'var(--background-secondary)';
                        promptItem.style.borderRadius = '4px';
                        promptItem.style.cursor = 'pointer';
                        promptItem.style.border = '1px solid transparent';

                        promptItem.addEventListener('mouseenter', () => {
                            promptItem.style.backgroundColor = 'var(--background-modifier-hover)';
                            promptItem.style.border = '1px solid var(--accent-color)';
                        });
                        promptItem.addEventListener('mouseleave', () => {
                            promptItem.style.backgroundColor = 'var(--background-secondary)';
                            promptItem.style.border = '1px solid transparent';
                        });

                        const promptName = promptItem.createDiv();
                        promptName.textContent = prompt.name;
                        promptName.style.fontWeight = '500';

                        if (prompt.description) {
                            const desc = promptItem.createDiv();
                            desc.textContent = prompt.description;
                            desc.style.fontSize = '12px';
                            desc.style.color = 'var(--text-muted)';
                            desc.style.marginTop = '4px';
                        }

                        promptItem.onclick = () => {
                            this.activateMCPPrompt(server.name, prompt);
                            modal.close();
                            setTimeout(() => this.chatInput.focus(), 100);
                        };
                    });
                }

                if (tools.length === 0 && prompts.length === 0) {
                    const emptyMsg = previewContent.createDiv();
                    emptyMsg.textContent = 'No tools or prompts available for this server.';
                    emptyMsg.style.color = 'var(--text-muted)';
                    emptyMsg.style.fontStyle = 'italic';
                }
            };

            // Simple keyboard navigation
            const handleKeydown = (e: KeyboardEvent) => {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    selectedIndex = selectedIndex === 0 ? servers.length - 1 : selectedIndex - 1;

                    // Update selection
                    mcpServerItems.forEach(el => {
                        el.style.backgroundColor = 'var(--background-secondary)';
                        el.style.border = '1px solid transparent';
                        el.classList.remove('selected');
                    });
                    mcpServerItems[selectedIndex].style.backgroundColor = 'var(--background-modifier-hover)';
                    mcpServerItems[selectedIndex].style.border = '1px solid var(--accent-color)';
                    mcpServerItems[selectedIndex].classList.add('selected');

                    showPreview(servers[selectedIndex]);
                    mcpServerItems[selectedIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    selectedIndex = (selectedIndex + 1) % servers.length;

                    // Update selection
                    mcpServerItems.forEach(el => {
                        el.style.backgroundColor = 'var(--background-secondary)';
                        el.style.border = '1px solid transparent';
                        el.classList.remove('selected');
                    });
                    mcpServerItems[selectedIndex].style.backgroundColor = 'var(--background-modifier-hover)';
                    mcpServerItems[selectedIndex].style.border = '1px solid var(--accent-color)';
                    mcpServerItems[selectedIndex].classList.add('selected');

                    showPreview(servers[selectedIndex]);
                    mcpServerItems[selectedIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.activateMCPServer(servers[selectedIndex]);
                    modal.close();
                    setTimeout(() => this.chatInput.focus(), 100);
                } else if (e.key === 'Escape') {
                    modal.close();
                }
            };

            modal.modalEl.addEventListener('keydown', handleKeydown);
            modal.onClose = () => {
                modal.modalEl.removeEventListener('keydown', handleKeydown);
            };

            // Set focus for keyboard navigation
            modal.modalEl.setAttribute('tabindex', '-1');
            modal.modalEl.focus();

            // Show initial preview
            if (servers.length > 0) {
                showPreview(servers[0]);
            }

        } catch (error) {
            console.error('Error in MCP selector:', error);
            contentEl.createEl('p', { text: `Error loading MCP data: ${error.message}` });
        }
    }

    showAddServerForm(contentEl: HTMLElement, modal: Modal) {
        contentEl.empty();

        const formContainer = contentEl.createDiv();
        formContainer.style.padding = '16px';
        formContainer.style.maxWidth = '500px';
        formContainer.style.margin = '0 auto';

        formContainer.createEl('h3', { text: 'Add MCP Server' });
        formContainer.createEl('p', {
            text: 'Configure a new MCP server to enable AI tools.',
            cls: 'setting-item-description'
        });

        let selectedTransport = 'stdio';
        let nameInput: HTMLInputElement;
        let commandInput: HTMLInputElement;
        let argsInput: HTMLInputElement;
        let endpointInput: HTMLInputElement;
        let envVars: {key: string, value: string}[] = [];

        // Server name
        const nameContainer = formContainer.createDiv();
        nameContainer.style.marginTop = '16px';
        nameContainer.createEl('label', { text: 'Server Name' });
        nameInput = nameContainer.createEl('input', {
            type: 'text',
            attr: { placeholder: 'e.g., Filesystem, GitHub, etc.' }
        });
        nameInput.style.width = '100%';
        nameInput.style.marginTop = '4px';
        nameInput.style.padding = '8px';

        // Transport toggle
        const transportContainer = formContainer.createDiv();
        transportContainer.style.marginTop = '16px';
        transportContainer.createEl('label', { text: 'Server Type' });

        const transportToggle = transportContainer.createDiv();
        transportToggle.style.marginTop = '8px';
        transportToggle.style.display = 'flex';
        transportToggle.style.gap = '16px';

        const stdioOption = transportToggle.createEl('label');
        stdioOption.style.cursor = 'pointer';
        stdioOption.style.display = 'flex';
        stdioOption.style.alignItems = 'center';
        stdioOption.style.gap = '6px';
        const stdioRadio = stdioOption.createEl('input', { type: 'radio', value: 'stdio' });
        stdioRadio.name = 'transport';
        stdioRadio.checked = true;
        stdioOption.createSpan({ text: 'Local (stdio)' });

        const httpOption = transportToggle.createEl('label');
        httpOption.style.cursor = 'pointer';
        httpOption.style.display = 'flex';
        httpOption.style.alignItems = 'center';
        httpOption.style.gap = '6px';
        const httpRadio = httpOption.createEl('input', { type: 'radio', value: 'http' });
        httpRadio.name = 'transport';
        httpOption.createSpan({ text: 'Remote (WebSocket)' });

        // Configuration container
        const configContainer = formContainer.createDiv();
        configContainer.style.marginTop = '16px';

        const updateConfig = () => {
            configContainer.empty();

            if (selectedTransport === 'stdio') {
                // Command
                configContainer.createEl('label', { text: 'Command' });
                commandInput = configContainer.createEl('input', {
                    type: 'text',
                    value: 'npx',
                    attr: { placeholder: 'npx' }
                });
                commandInput.style.width = '100%';
                commandInput.style.marginTop = '4px';
                commandInput.style.padding = '8px';

                // Arguments
                const argsLabel = configContainer.createEl('label', { text: 'Arguments' });
                argsLabel.style.marginTop = '12px';
                argsLabel.style.display = 'block';
                argsInput = configContainer.createEl('input', {
                    type: 'text',
                    attr: { placeholder: '-y @modelcontextprotocol/server-filesystem /path' }
                });
                argsInput.style.width = '100%';
                argsInput.style.marginTop = '4px';
                argsInput.style.padding = '8px';

                // Example text
                const exampleText = configContainer.createEl('p', {
                    text: 'Example: npx -y @modelcontextprotocol/server-filesystem /home/user/documents',
                    cls: 'setting-item-description'
                });
                exampleText.style.marginTop = '8px';
                exampleText.style.fontSize = '12px';

            } else {
                // WebSocket endpoint
                configContainer.createEl('label', { text: 'WebSocket Endpoint' });
                endpointInput = configContainer.createEl('input', {
                    type: 'url',
                    attr: { placeholder: 'wss://your-mcp-server.com/mcp' }
                });
                endpointInput.style.width = '100%';
                endpointInput.style.marginTop = '4px';
                endpointInput.style.padding = '8px';
            }
        };

        stdioRadio.onchange = () => {
            selectedTransport = 'stdio';
            updateConfig();
        };

        httpRadio.onchange = () => {
            selectedTransport = 'http';
            updateConfig();
        };

        updateConfig();

        // Action buttons
        const buttonContainer = formContainer.createDiv();
        buttonContainer.style.marginTop = '24px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.justifyContent = 'flex-end';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => modal.close();

        const saveBtn = buttonContainer.createEl('button', { text: 'Add Server', cls: 'mod-cta' });
        saveBtn.onclick = async () => {
            const name = nameInput.value.trim();
            if (!name) {
                nameInput.style.border = '1px solid var(--text-error)';
                return;
            }

            // Create server config
            const serverConfig: MCPServer = {
                id: `mcp-${Date.now()}`,
                name,
                transport: selectedTransport as 'stdio' | 'http',
                connected: false
            };

            if (selectedTransport === 'stdio') {
                serverConfig.command = commandInput?.value.trim() || 'npx';
                serverConfig.args = argsInput?.value.trim().split(' ').filter(a => a);
            } else {
                serverConfig.endpoint = endpointInput?.value.trim();
            }

            // Add to settings
            if (!this.plugin.settings.mcpServers) {
                this.plugin.settings.mcpServers = [];
            }
            this.plugin.settings.mcpServers.push(serverConfig);

            // Enable MCP if not already
            this.plugin.settings.mcpEnabled = true;
            await this.plugin.saveSettings();

            // Try to connect
            try {
                const success = await this.plugin.mcpClientManager.addServer(serverConfig);
                if (success) {
                    this.addMessage(`Connected to MCP server "${name}". Use /mcp to select tools.`, 'system');
                } else {
                    this.addMessage(`Added MCP server "${name}" but connection failed. Check settings.`, 'error');
                }
            } catch (error) {
                this.addMessage(`Added MCP server "${name}" but connection failed: ${error.message}`, 'error');
            }

            modal.close();
        };

        // Focus name input
        setTimeout(() => nameInput.focus(), 100);
    }

    activateMCPServer(server: MCPServer) {
        try {
            // Ensure activeMCPServers is initialized as an array
            if (!this.activeMCPServers || !Array.isArray(this.activeMCPServers)) {
                this.activeMCPServers = [];
            }

            // Find existing active server
            const existingIndex = this.activeMCPServers.findIndex(s => s.name === server.name);
            if (existingIndex >= 0) {
                // Server is already active - show message
                this.addMessage(`MCP server "${server.name}" is already active.`, 'system');
                return;
            }
        } catch (error) {
            console.error('Error checking existing MCP servers:', error);
            // Initialize empty array on error
            this.activeMCPServers = [];
        }

        // Get tools, prompts, and resources for this server with enhanced error handling
        try {
            const mcpManager = this.plugin.mcpClientManager;
            const tools = mcpManager?.getTools().get(server.id) || [];
            const prompts = mcpManager?.getPrompts().get(server.id) || [];
            const resources = mcpManager?.getResources().get(server.id) || [];

            console.log(`MCP Debug - Activating server ${server.name} with ${tools.length} tools, ${prompts.length} prompts, and ${resources.length} resources`);

            this.activeMCPServers.push({
                name: server.name,
                tools: tools || [],
                prompts: prompts || [],
                resources: resources || [],
                highlightedTools: []
            });
            this.addMessage(`MCP server "${server.name}" activated with ${tools.length} tools, ${prompts.length} prompts, and ${resources.length} resources.`, 'system');
        } catch (error) {
            console.error('Error activating MCP server:', server.name, error);
            // Add server with empty arrays to prevent undefined errors
            this.activeMCPServers.push({
                name: server.name,
                tools: [],
                prompts: [],
                resources: [],
                highlightedTools: []
            });
        }

        this.updateMCPIndicator();
    }

    deactivateMCPServer(serverName: string) {
        if (!this.activeMCPServers || !Array.isArray(this.activeMCPServers)) {
            return;
        }
        const index = this.activeMCPServers.findIndex(s => s.name === serverName);
        if (index >= 0) {
            this.activeMCPServers.splice(index, 1);
            this.addMessage(`MCP server "${serverName}" deactivated.`, 'system');
        }
        this.updateMCPIndicator();
    }

    toggleMCPServer(server: MCPServer): boolean {
        const isActive = this.activeMCPServers?.some(s => s.name === server.name);
        if (isActive) {
            this.deactivateMCPServer(server.name);
        } else {
            this.activateMCPServer(server);
        }
        return !isActive;
    }

    async executeMCPTool(functionName: string, args: any): Promise<any> {
        try {
            console.log(`executeMCPTool called with function: ${functionName}, args:`, args);

            // Validate inputs
            if (!functionName || typeof functionName !== 'string') {
                throw new Error(`Invalid function name: ${functionName}`);
            }

            // Parse server name and tool name from function name format: "serverName_toolName"
            const parts = functionName.split('_');
            if (!parts || !Array.isArray(parts) || parts.length < 2) {
                const error = `Invalid function name format: ${functionName}`;
                console.error(error);
                throw new Error(error);
            }

            const serverName = parts[0];
            const toolName = parts.slice(1).join('_'); // Handle tools with underscores
            console.log(`Parsed server: ${serverName}, tool: ${toolName}`);

        // Find the MCP server
        const mcpManager = this.plugin.mcpClientManager;
        if (!mcpManager) {
            const error = 'MCP manager not available';
            console.error(error);
            throw new Error(error);
        }

        // Find server by name
        const servers = Array.from(mcpManager.getServers().values()) as MCPServer[];
        console.log('Available MCP servers:', servers.map(s => ({name: s.name, id: s.id, connected: s.connected})));

        const server = servers.find(s => s.name === serverName);
        if (!server) {
            const error = `MCP server not found: ${serverName}`;
            console.error(error, 'Available servers:', servers.map(s => s.name));
            throw new Error(error);
        }

        console.log(`Found server: ${server.name} (${server.id}), connected: ${server.connected}`);

        // Execute the tool
            console.log(`Executing MCP tool: ${toolName} on server: ${serverName} (${server.id}) with args:`, args);
            const result = await mcpManager.executeTool(server.id, toolName, args);
            console.log(`MCP tool execution result:`, result);
            return result;
        } catch (error) {
            console.error(`MCP executeMCPTool: Comprehensive error handler caught:`, error);
            console.error(`MCP executeMCPTool: Error stack:`, error.stack);
            console.error(`MCP executeMCPTool: Function name: ${functionName}, args:`, args);

            // Re-throw with more context
            throw new Error(`MCP Tool Execution Failed [${functionName}]: ${error.message}`);
        }
    }

    activateMCPTool(serverName: string, tool: MCPTool) {
        try {
            // Ensure activeMCPServers is initialized as an array
            if (!this.activeMCPServers || !Array.isArray(this.activeMCPServers)) {
                this.activeMCPServers = [];
            }

            // Ensure server is active
            let serverEntry = this.activeMCPServers.find(s => s.name === serverName);
            if (!serverEntry) {
                const mcpManager = this.plugin.mcpClientManager;
                // Find server by name since we get serverName parameter
                const server = Array.from(mcpManager?.getServers().values() || []).find(s => s.name === serverName);
                if (server) this.activateMCPServer(server);
                serverEntry = this.activeMCPServers.find(s => s.name === serverName);
            }

            // Add tool to highlighted list
            if (serverEntry) {
                if (!serverEntry.highlightedTools) {
                    serverEntry.highlightedTools = [];
                }
                if (!serverEntry.highlightedTools.includes(tool.name)) {
                    serverEntry.highlightedTools.push(tool.name);
                    this.addMessage(`Tool "${tool.name}" highlighted for priority use.`, 'system');
                }
                this.updateMCPIndicator();
            }
        } catch (error) {
            console.error('Error activating MCP tool:', serverName, tool.name, error);
        }
    }

    activateMCPPrompt(serverName: string, prompt: MCPPrompt) {
        // Add prompt content to chat input
        const currentInput = this.chatInput.value;
        const promptText = `[MCP Prompt: ${prompt.name}]\n${prompt.description || ''}`;

        this.chatInput.value = currentInput + (currentInput ? '\n\n' : '') + promptText;
    }

    updateMCPIndicator() {
        if (!this.mcpIndicator) return;

        if (this.activeMCPServers && this.activeMCPServers.length > 0) {
            // Use correct Lucide bow-arrow icon
            this.mcpIndicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bow-arrow-icon lucide-bow-arrow"><path d="M17 3h4v4"/><path d="M18.575 11.082a13 13 0 0 1 1.048 9.027 1.17 1.17 0 0 1-1.914.597L14 17"/><path d="M7 10 3.29 6.29a1.17 1.17 0 0 1 .6-1.91 13 13 0 0 1 9.03 1.05"/><path d="M7 14a1.7 1.7 0 0 0-1.207.5l-2.646 2.646A.5.5 0 0 0 3.5 18H5a1 1 0 0 1 1 1v1.5a.5.5 0 0 0 .854.354L9.5 18.207A1.7 1.7 0 0 0 10 17v-2a1 1 0 0 0-1-1z"/><path d="M9.707 14.293 21 3"/></svg>';
            this.mcpIndicator.style.display = 'flex';

            // Build detailed tooltip with servers and their tools (without "Active MCP:" prefix)
            const tooltipLines: string[] = [];
            for (const activeServer of this.activeMCPServers) {
                try {
                    const serverLine = `${activeServer.name}:`;
                    tooltipLines.push(serverLine);

                    const tools = activeServer.tools || [];
                    const prompts = activeServer.prompts || [];
                    const resources = activeServer.resources || [];
                    const highlighted = activeServer.highlightedTools || [];

                    if (tools.length > 0) {
                        const toolNames = tools.map(t => {
                            const isHighlighted = highlighted.includes(t.name);
                            return `  ${isHighlighted ? '★' : '•'} ${t.name}${isHighlighted ? ' (selected)' : ''}`;
                        }).join('\n');
                        tooltipLines.push(toolNames);
                    }

                    if (prompts.length > 0) {
                        const promptNames = prompts.map(p => `  • ${p.name} (prompt)`).join('\n');
                        tooltipLines.push(promptNames);
                    }

                    if (resources.length > 0) {
                        const resourceNames = resources.map(r => `  • ${r.name} (resource)`).join('\n');
                        tooltipLines.push(resourceNames);
                    }

                    if (tools.length === 0 && prompts.length === 0 && resources.length === 0) {
                        tooltipLines.push('  • (server only)');
                    }
                } catch (error) {
                    console.error('Error processing MCP server for tooltip:', activeServer, error);
                    tooltipLines.push(`${activeServer.name || 'Unknown Server'}: (error loading tools/prompts)`);
                }
            }

            // Remove all tooltip attributes to test if that fixes double tooltip
            this.mcpIndicator.removeAttribute('title');
            this.mcpIndicator.removeAttribute('aria-label');

            // Create custom tooltip on hover to replace native browser tooltip
            let tooltipElement: HTMLElement | null = null;

            this.mcpIndicator.addEventListener('mouseenter', (e) => {
                // Remove any existing tooltip
                if (tooltipElement) {
                    tooltipElement.remove();
                }

                // Create custom tooltip
                tooltipElement = document.createElement('div');
                tooltipElement.className = 'stella-mcp-tooltip';
                tooltipElement.style.position = 'fixed';
                tooltipElement.style.backgroundColor = 'var(--background-primary)';
                tooltipElement.style.color = 'var(--text-normal)';
                tooltipElement.style.padding = '8px 12px';
                tooltipElement.style.borderRadius = '6px';
                tooltipElement.style.border = '1px solid var(--background-modifier-border)';
                tooltipElement.style.fontSize = '13px';
                tooltipElement.style.zIndex = '10000';
                tooltipElement.style.pointerEvents = 'none';
                tooltipElement.style.whiteSpace = 'pre-line';
                tooltipElement.style.minWidth = '200px';
                tooltipElement.style.maxWidth = '400px';
                tooltipElement.style.lineHeight = '1.4';
                tooltipElement.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.15)';

                const tooltipText = tooltipLines.join('\n');
                tooltipElement.textContent = tooltipText;

                // Temporarily add to DOM to get actual dimensions
                tooltipElement.style.visibility = 'hidden';
                document.body.appendChild(tooltipElement);
                const tooltipRect = tooltipElement.getBoundingClientRect();

                // Position tooltip above the icon, centered
                const rect = this.mcpIndicator.getBoundingClientRect();
                const left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
                const top = rect.top - tooltipRect.height - 10;

                // Ensure tooltip stays within viewport
                const finalLeft = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));
                const finalTop = Math.max(10, top);

                tooltipElement.style.left = `${finalLeft}px`;
                tooltipElement.style.top = `${finalTop}px`;
                tooltipElement.style.visibility = 'visible';

                document.body.appendChild(tooltipElement);
            });

            this.mcpIndicator.addEventListener('mouseleave', () => {
                if (tooltipElement) {
                    tooltipElement.remove();
                    tooltipElement = null;
                }
            });
        } else {
            this.mcpIndicator.innerHTML = '';
            this.mcpIndicator.style.display = 'none';
        }

        this.updateIndicatorPositions();
    }

    clearMCPContext() {
        this.activeMCPServers = [];
        console.log('MCP context cleared');

        if (this.currentConversationId) {
            const conversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);
            if (conversation) {
                conversation.mcpServers = [];
                conversation.updatedAt = Date.now();
                this.plugin.saveSettings();
                console.log('MCP context removed from conversation');
            }
        }

        this.updateMCPIndicator();
    }

    clearAllContext() {
        // Clear system prompt
        this.unloadSystemPrompt();

        // Clear mental model
        this.unloadMentalModel();

        // Clear MCP context
        this.activeMCPServers = [];

        // Clear note context
        this.contextNotes = [];

        // Start new conversation
        this.startNewConversation();

        console.log('All context cleared and new conversation started');

        // Update all indicators
        this.updateSystemPromptIndicator();
        this.updateMentalModelIndicator();
        this.updateMCPIndicator();
        this.updateContextIndicator();
    }

    async detectAndActivateMCP(message: string) {
        if (!this.plugin.mcpClientManager) return;

        const mcpManager = this.plugin.mcpClientManager;
        const servers = Array.from(mcpManager.getServers().values()) as MCPServer[];

        // Check for tool names in the message
        for (const server of servers) {
            const tools = mcpManager.getTools().get(server.id) || [];
            const prompts = mcpManager.getPrompts().get(server.id) || [];

            // Auto-detect tool names in the message
            for (const tool of tools) {
                const toolNameRegex = new RegExp(`\\b${tool.name}\\b`, 'i');
                if (toolNameRegex.test(message)) {
                    this.activateMCPTool(server.name, tool);
                }
            }

            // Auto-detect prompt names in the message
            for (const prompt of prompts) {
                const promptNameRegex = new RegExp(`\\b${prompt.name}\\b`, 'i');
                if (promptNameRegex.test(message)) {
                    this.activateMCPPrompt(server.name, prompt);
                }
            }

            // Auto-detect server names in the message
            const serverNameRegex = new RegExp(`\\b${server.name}\\b`, 'i');
            if (serverNameRegex.test(message)) {
                this.activateMCPServer(server);
            }
        }

        // Look for general MCP-related keywords
        const mcpKeywords = ['file system', 'filesystem', 'directory', 'folders', 'github', 'git repo', 'database', 'sql', 'api', 'weather', 'calendar'];
        const messageLower = message.toLowerCase();

        for (const keyword of mcpKeywords) {
            if (messageLower.includes(keyword)) {
                // Find appropriate server based on keyword
                const relevantServer = servers.find((s: MCPServer) => {
                    if (keyword.includes('file') || keyword.includes('directory') || keyword.includes('folder')) {
                        return s.name.toLowerCase().includes('file') || s.name.toLowerCase().includes('fs');
                    }
                    if (keyword.includes('github') || keyword.includes('git')) {
                        return s.name.toLowerCase().includes('github') || s.name.toLowerCase().includes('git');
                    }
                    if (keyword.includes('database') || keyword.includes('sql')) {
                        return s.name.toLowerCase().includes('database') || s.name.toLowerCase().includes('sql');
                    }
                    if (keyword.includes('weather')) {
                        return s.name.toLowerCase().includes('weather');
                    }
                    if (keyword.includes('calendar')) {
                        return s.name.toLowerCase().includes('calendar');
                    }
                    return false;
                });

                if (relevantServer && !this.activeMCPServers.find(s => s.name === relevantServer.name)) {
                    this.activateMCPServer(relevantServer);
                }
                break; // Only activate one server per keyword match
            }
        }
    }

    updateBackgroundImage() {
        console.log('updateBackgroundImage called');
        if (!this.chatContainer) {
            console.log('No chatContainer found');
            return;
        }

        const { backgroundImage, backgroundMode, backgroundOpacity } = this.plugin.settings;
        console.log('Background settings:', { backgroundImage, backgroundMode, backgroundOpacity });

        if (!backgroundImage) {
            console.log('No background image set, clearing styles');
            // Remove background image by clearing CSS custom properties
            this.chatContainer.style.setProperty('--bg-image', 'none');
            this.chatContainer.style.setProperty('--bg-size', 'auto');
            this.chatContainer.style.setProperty('--bg-opacity', '1');
            return;
        }

        try {
            // Handle both URLs and local file paths
            let imageUrl = backgroundImage;

            // Check if it's a local file path (Windows or Unix style)
            const isLocalPath = !backgroundImage.startsWith('http') &&
                               (backgroundImage.includes('\\') || backgroundImage.startsWith('/') || /^[A-Za-z]:/.test(backgroundImage));

            console.log('isLocalPath:', isLocalPath);

            if (isLocalPath) {
                // Use base64 method as primary approach for local files
                try {
                    // Convert to data URL using file reading
                    const fs = require('fs');
                    const fileBuffer = fs.readFileSync(backgroundImage);
                    const base64 = fileBuffer.toString('base64');
                    const fileExt = backgroundImage.split('.').pop()?.toLowerCase();
                    const mimeType = fileExt === 'webp' ? 'image/webp' :
                                   fileExt === 'png' ? 'image/png' :
                                   fileExt === 'jpg' || fileExt === 'jpeg' ? 'image/jpeg' :
                                   fileExt === 'gif' ? 'image/gif' : 'image/*';
                    imageUrl = `data:${mimeType};base64,${base64}`;
                    console.log('Using base64 data URL for local file (size: ~' + Math.round(base64.length / 1024) + 'KB)');
                } catch (fsError) {
                    console.log('Failed to read file as base64:', fsError);

                    // Fallback: Try using Obsidian's resource path
                    try {
                        const adapter = this.app.vault.adapter as any;
                        if (adapter && adapter.getResourcePath) {
                            const cleanPath = backgroundImage.replace(/\\/g, '/');
                            imageUrl = adapter.getResourcePath(cleanPath);
                            console.log('Fallback: Using Obsidian resource path:', imageUrl);
                        } else {
                            // Final fallback: direct path
                            imageUrl = backgroundImage.replace(/\\/g, '/');
                            console.log('Final fallback: Using direct path:', imageUrl);
                        }
                    } catch (e2) {
                        console.log('All methods failed:', e2);
                        imageUrl = backgroundImage.replace(/\\/g, '/');
                    }
                }
            }

            // Set background image using CSS custom properties
            console.log('Setting background image to:', imageUrl);
            this.chatContainer.style.setProperty('--bg-image', `url("${imageUrl}")`);

            // Set background mode
            console.log('Setting background mode to:', backgroundMode);
            let backgroundSize;
            switch (backgroundMode) {
                case 'centered':
                    backgroundSize = 'auto';
                    break;
                case 'fill':
                    backgroundSize = 'cover';
                    break;
                case 'stretch':
                    backgroundSize = '100% 100%';
                    break;
                default:
                    backgroundSize = 'cover';
            }
            this.chatContainer.style.setProperty('--bg-size', backgroundSize);

            // Use CSS custom property for opacity
            console.log('Setting opacity to:', backgroundOpacity);
            this.chatContainer.style.setProperty('--bg-opacity', backgroundOpacity.toString());

            console.log('Background image applied successfully');

        } catch (error) {
            console.error('Error setting background image:', error);
            // Fallback: clear background if there's an error
            this.messagesContainer.style.backgroundImage = '';
        }
    }


    updateHeaderVisibility() {
        if (!this.headerContainer) {
            return;
        }

        const shouldHide = this.plugin.settings.autoHideHeader;

        if (shouldHide) {
            this.headerContainer.style.display = 'none';
        } else {
            this.headerContainer.style.display = 'flex';
        }
    }

    toggleHeader() {
        if (!this.headerContainer) {
            return;
        }

        // Toggle the current visibility state
        this.plugin.settings.autoHideHeader = !this.plugin.settings.autoHideHeader;

        // Save settings
        this.plugin.saveSettings();

        // Apply the change with transition
        const isHiding = this.plugin.settings.autoHideHeader;

        if (isHiding) {
            this.headerContainer.style.opacity = '0';
            this.headerContainer.style.transform = 'translateY(-100%)';
            setTimeout(() => {
                this.headerContainer.style.display = 'none';
            }, 300);
        } else {
            this.headerContainer.style.display = 'flex';
            this.headerContainer.style.opacity = '0';
            this.headerContainer.style.transform = 'translateY(-100%)';

            // Force reflow
            this.headerContainer.offsetHeight;

            this.headerContainer.style.opacity = '1';
            this.headerContainer.style.transform = 'translateY(0)';
        }
    }

    showNameInput() {
        // If no backing conversation exists, create one that preserves current state
        if (!this.currentConversationId) {
            const now = new Date();
            const localDateStr = now.toLocaleDateString('en-CA');
            const newConversation: Conversation = {
                id: `conv_${Date.now()}`,
                title: localDateStr,
                messages: [...this.chatHistory],
                systemPrompt: this.currentSystemPrompt || undefined,
                systemPromptFilename: this.currentSystemPromptFilename || undefined,
                mentalModel: this.currentMentalModel || undefined,
                mentalModelFilename: this.currentMentalModelFilename || undefined,
                createdAt: now.getTime(),
                updatedAt: now.getTime()
            };
            this.plugin.settings.conversations.unshift(newConversation);
            this.plugin.settings.currentConversationId = newConversation.id;
            this.currentConversationId = newConversation.id;
        }

        const currentConversation = this.plugin.settings.conversations.find(c => c.id === this.currentConversationId);

        if (!currentConversation) {
            new Notice('No active conversation to rename');
            return;
        }

        const modal = new Modal(this.app);
        modal.setTitle('Rename Conversation');

        const currentName = currentConversation.title;

        const input = modal.contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter conversation name...',
            value: currentName
        });

        input.style.width = '100%';
        input.style.marginBottom = '16px';
        input.style.padding = '8px';
        input.style.fontSize = '14px';
        input.style.border = '1px solid var(--background-modifier-border)';
        input.style.borderRadius = '4px';
        input.style.background = 'var(--background-primary)';
        input.style.color = 'var(--text-normal)';

        const buttonContainer = modal.contentEl.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.style.padding = '8px 16px';
        cancelButton.style.border = '1px solid var(--background-modifier-border)';
        cancelButton.style.borderRadius = '4px';
        cancelButton.style.background = 'var(--background-secondary)';
        cancelButton.style.color = 'var(--text-normal)';
        cancelButton.style.cursor = 'pointer';

        const saveButton = buttonContainer.createEl('button', { text: 'Save' });
        saveButton.style.padding = '8px 16px';
        saveButton.style.border = '1px solid var(--interactive-accent)';
        saveButton.style.borderRadius = '4px';
        saveButton.style.background = 'var(--interactive-accent)';
        saveButton.style.color = 'var(--text-on-accent)';
        saveButton.style.cursor = 'pointer';

        // Event handlers
        const saveName = async () => {
            const newName = input.value.trim();
            if (!newName) {
                new Notice('Please enter a name');
                return;
            }
            currentConversation.title = newName;
            await this.plugin.saveSettings();
            // Update the UI
            this.conversationNameInput.value = newName;
            modal.close();
        };

        cancelButton.addEventListener('click', () => modal.close());
        saveButton.addEventListener('click', saveName);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveName();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                modal.close();
            }
        });

        modal.open();

        // Focus the input after modal is open
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);
    }

    openPluginSettings() {
        // Open plugin settings via Obsidian's settings interface
        const app = this.app as any;
        app.setting.open();
        app.setting.openTabById('stella');
    }

    async onClose() {
        // Cleanup async logger
        if (this.logger) {
            this.logger.destroy();
        }
    }
}

// Settings Tab
class StellaSettingTab extends PluginSettingTab {
    plugin: StellaPlugin;

    constructor(app: App, plugin: StellaPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();


        // Provider selection
        new Setting(containerEl)
            .setName('AI Provider')
            .setDesc('Select your AI provider')
            .addDropdown(dropdown => dropdown
                .addOption('anthropic', 'Anthropic (Claude)')
                .addOption('openai', 'OpenAI (GPT)')
                .addOption('google', 'Google (Gemini)')
                .addOption('openrouter', 'OpenRouter')
                .addOption('ollama', 'Ollama (Local)')
                .addOption('lmstudio', 'LM Studio (Local)')
                .addOption('custom', 'Custom API')
                .addOption('openclaw', 'OpenClaw (Robin)')
                .addOption('hermes', 'Hermes Agent (Nous)')
                .setValue(this.plugin.settings.provider)
                .onChange(async (value) => {
                    this.plugin.settings.provider = value;
                    // Reset model when switching providers to avoid API errors
                    this.plugin.settings.model = '';
                    await this.plugin.saveSettings();
                    // Update ALL chat views' model info immediately
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateModelInfo) {
                            chatView.updateModelInfo(chatView.modelInfoContainer);
                        }
                    });
                    this.display(); // Refresh to show provider-specific settings
                }));

        // Provider-specific API key settings
        if (this.plugin.settings.provider === 'openai') {
            new Setting(containerEl)
                .setName('OpenAI API Key')
                .setDesc('Enter your OpenAI API key')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.openaiApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiApiKey = value;
                        await this.plugin.saveSettings();
                        this.refreshModelDropdown();
                    }));
        }

        if (this.plugin.settings.provider === 'anthropic') {
            new Setting(containerEl)
                .setName('Anthropic API Key')
                .setDesc('Enter your Anthropic API key')
                .addText(text => text
                    .setPlaceholder('sk-ant-...')
                    .setValue(this.plugin.settings.anthropicApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.anthropicApiKey = value;
                        await this.plugin.saveSettings();
                        this.refreshModelDropdown();
                    }));
        }

        if (this.plugin.settings.provider === 'google') {
            new Setting(containerEl)
                .setName('Google API Key')
                .setDesc('Enter your Google AI API key')
                .addText(text => text
                    .setPlaceholder('AI...')
                    .setValue(this.plugin.settings.googleApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.googleApiKey = value;
                        await this.plugin.saveSettings();
                        this.refreshModelDropdown();
                    }));
        }

        if (this.plugin.settings.provider === 'openrouter') {
            new Setting(containerEl)
                .setName('OpenRouter API Key')
                .setDesc('Enter your OpenRouter API key (openrouter.ai/keys)')
                .addText(text => text
                    .setPlaceholder('sk-or-...')
                    .setValue(this.plugin.settings.openrouterApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.openrouterApiKey = value.trim();
                        await this.plugin.saveSettings();
                    }));
        }

        if (this.plugin.settings.provider === 'ollama') {
            new Setting(containerEl)
                .setName('Ollama Base URL')
                .setDesc('Ollama server URL')
                .addText(text => text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.ollamaBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaBaseUrl = value;
                        await this.plugin.saveSettings();
                        this.refreshModelDropdown();
                    }));
        }

        if (this.plugin.settings.provider === 'lmstudio') {
            new Setting(containerEl)
                .setName('LM Studio Base URL')
                .setDesc('LM Studio server URL')
                .addText(text => text
                    .setPlaceholder('http://localhost:1234')
                    .setValue(this.plugin.settings.lmStudioBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.lmStudioBaseUrl = value;
                        await this.plugin.saveSettings();
                        this.refreshModelDropdown();
                    }));
        }

        if (this.plugin.settings.provider === 'custom') {
            new Setting(containerEl)
                .setName('Custom API URL')
                .setDesc('Your custom API endpoint URL')
                .addText(text => text
                    .setPlaceholder('https://your-api.com/v1/chat/completions')
                    .setValue(this.plugin.settings.customApiUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.customApiUrl = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Custom API Key')
                .setDesc('API key for your custom endpoint (optional)')
                .addText(text => text
                    .setPlaceholder('your-api-key')
                    .setValue(this.plugin.settings.customApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.customApiKey = value;
                        await this.plugin.saveSettings();
                    }));
        }

        if (this.plugin.settings.provider === 'openclaw') {
            new Setting(containerEl)
                .setName('Gateway URL')
                .setDesc('OpenClaw Gateway WebSocket URL (e.g. ws://127.0.0.1:18789)')
                .addText(text => text
                    .setPlaceholder('ws://127.0.0.1:18789')
                    .setValue(this.plugin.settings.customApiUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.customApiUrl = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Gateway Token')
                .setDesc('Authentication token for the OpenClaw Gateway')
                .addText(text => text
                    .setPlaceholder('your-gateway-token')
                    .setValue(this.plugin.settings.customApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.customApiKey = value;
                        await this.plugin.saveSettings();
                    }));

            containerEl.createEl('p', {
                text: '🌙 OpenClaw connects via WebSocket for full agent integration — persistent session, native tools, memory, and MCP servers.',
                cls: 'setting-item-description'
            });
        }

        if (this.plugin.settings.provider === 'hermes') {
            new Setting(containerEl)
                .setName('Hermes API URL')
                .setDesc('Address of the Hermes gateway\'s API server (port 8642 by default — not the 9119 dashboard)')
                .addText(text => text
                    .setPlaceholder('http://127.0.0.1:8642')
                    .setValue(this.plugin.settings.hermesUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.hermesUrl = value.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Hermes API Key')
                .setDesc('The gateway\'s API_SERVER_KEY, from ~/.hermes/.env on the Hermes machine')
                .addText(text => {
                    text.inputEl.type = 'password';
                    text
                        .setPlaceholder('API_SERVER_KEY')
                        .setValue(this.plugin.settings.hermesApiKey)
                        .onChange(async (value) => {
                            this.plugin.settings.hermesApiKey = value.trim();
                            await this.plugin.saveSettings();
                        });
                });

            containerEl.createEl('p', {
                text: '⚡ Hermes Agent (Nous Research) is a full agent, not a raw model — it brings its own model routing, tools, skills, and memory. Replies appear all at once when Hermes finishes, not word by word.',
                cls: 'setting-item-description'
            });
        }

        // Model selection - dynamically populated
        this.modelSetting = new Setting(containerEl)
            .setName('Model')
            .setDesc('Select the model to use (fetched from API)')
            .addButton(button => button
                .setButtonText('Refresh Models')
                .onClick(() => this.refreshModelDropdown()));

        this.modelDropdown = this.modelSetting.addDropdown(dropdown => {
            dropdown.setValue(this.plugin.settings.model);
            dropdown.onChange(async (value) => {
                this.plugin.settings.model = value;
                await this.plugin.saveSettings();
                // Update ALL chat views' model info immediately
                this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                    const chatView = leaf.view as StellaChatView;
                    if (chatView && chatView.updateModelInfo) {
                        chatView.updateModelInfo(chatView.modelInfoContainer);
                    }
                });
            });
            return dropdown;
        });

        // Load models on display
        setTimeout(() => {
            console.log('Settings tab displayed, refreshing model dropdown...');
            this.refreshModelDropdown();
        }, 100);

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc('Maximum tokens per response')
            .addText(text => text
                .setValue(this.plugin.settings.maxTokens.toString())
                .onChange(async (value) => {
                    this.plugin.settings.maxTokens = parseInt(value) || 4000;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Creativity level (0-1)')
            .addText(text => text
                .setValue(this.plugin.settings.temperature.toString())
                .onChange(async (value) => {
                    this.plugin.settings.temperature = parseFloat(value) || 0.7;
                    await this.plugin.saveSettings();
                }));

        // System prompts directory setting with browse button
        const systemPromptsPathSetting = new Setting(containerEl)
            .setName('System Prompts Directory')
            .setDesc('Path to directory containing your system prompt .md files (for /sys command)');
        let systemPromptsInput: any;
        systemPromptsPathSetting.addText(text => {
            systemPromptsInput = text;
            text.setPlaceholder('/path/to/your/system-prompts')
                .setValue(this.plugin.settings.systemPromptsPath)
                .onChange(async (value) => {
                    this.plugin.settings.systemPromptsPath = value;
                    await this.plugin.saveSettings();
                });
        });
        systemPromptsPathSetting.addButton(button => button
            .setButtonText('Browse')
            .onClick(async () => {
                const folders = this.app.vault.getAllLoadedFiles().filter(f => (f as any).children !== undefined);
                const modal = new FolderSuggestModal(this.app, folders, async (folder) => {
                    this.plugin.settings.systemPromptsPath = folder.path;
                    systemPromptsInput.setValue(folder.path);
                    await this.plugin.saveSettings();
                });
                modal.open();
            }));

        // Mental models directory setting with browse button
        const mentalModelsPathSetting = new Setting(containerEl)
            .setName('Mental Models Directory')
            .setDesc('Path to directory containing your mental model .md files (for /model command)');
        let mentalModelsInput: any;
        mentalModelsPathSetting.addText(text => {
            mentalModelsInput = text;
            text.setPlaceholder('/path/to/your/mental-models')
                .setValue(this.plugin.settings.mentalModelsPath)
                .onChange(async (value) => {
                    this.plugin.settings.mentalModelsPath = value;
                    await this.plugin.saveSettings();
                });
        });
        mentalModelsPathSetting.addButton(button => button
            .setButtonText('Browse')
            .onClick(async () => {
                const folders = this.app.vault.getAllLoadedFiles().filter(f => (f as any).children !== undefined);
                const modal = new FolderSuggestModal(this.app, folders, async (folder) => {
                    this.plugin.settings.mentalModelsPath = folder.path;
                    mentalModelsInput.setValue(folder.path);
                    await this.plugin.saveSettings();
                });
                modal.open();
            }));

        // Background image setting with browse button
        const backgroundImageSetting = new Setting(containerEl)
            .setName('Background Image URL/Path')
            .setDesc('URL or local file path to background image for chat area');
        let backgroundImageInput: any;
        backgroundImageSetting.addText(text => {
            backgroundImageInput = text;
            text.setPlaceholder('https://example.com/image.jpg or /path/to/image.png')
                .setValue(this.plugin.settings.backgroundImage)
                .onChange(async (value) => {
                    this.plugin.settings.backgroundImage = value;
                    await this.plugin.saveSettings();
                    // Update all chat views with new background
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateBackgroundImage) {
                            chatView.updateBackgroundImage();
                        }
                    });
                });
        });
        backgroundImageSetting.addButton(button => button
            .setButtonText('Browse')
            .onClick(async () => {
                const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
                const files = this.app.vault.getFiles().filter(f => imageExtensions.includes(f.extension.toLowerCase()));
                if (files.length === 0) {
                    new Notice('No image files found in your vault.');
                    return;
                }
                const modal = new FileSuggestModal(this.app, files, async (file) => {
                    this.plugin.settings.backgroundImage = file.path;
                    backgroundImageInput.setValue(file.path);
                    await this.plugin.saveSettings();
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateBackgroundImage) {
                            chatView.updateBackgroundImage();
                        }
                    });
                });
                modal.open();
            }));

        new Setting(containerEl)
            .setName('Background Display Mode')
            .setDesc('How the background image should be displayed')
            .addDropdown(dropdown => dropdown
                .addOption('centered', 'Centered')
                .addOption('fill', 'Fill')
                .addOption('stretch', 'Stretch')
                .setValue(this.plugin.settings.backgroundMode)
                .onChange(async (value: 'centered' | 'fill' | 'stretch') => {
                    this.plugin.settings.backgroundMode = value;
                    await this.plugin.saveSettings();
                    // Update all chat views with new background mode
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateBackgroundImage) {
                            chatView.updateBackgroundImage();
                        }
                    });
                }));

        new Setting(containerEl)
            .setName('Background Opacity')
            .setDesc('Opacity of the background image (0.0 to 1.0)')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(this.plugin.settings.backgroundOpacity)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.backgroundOpacity = value;
                    await this.plugin.saveSettings();
                    // Update all chat views with new opacity
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateBackgroundImage) {
                            chatView.updateBackgroundImage();
                        }
                    });
                }));

        // Loading GIF setting with browse button
        const loadingGifSetting = new Setting(containerEl)
            .setName('Loading Animation GIF')
            .setDesc('Custom GIF to display while waiting for AI response (leave empty for default)');
        let loadingGifInput: any;
        loadingGifSetting.addText(text => {
            loadingGifInput = text;
            text.setPlaceholder('path/to/your/animation.gif')
                .setValue(this.plugin.settings.loadingGif)
                .onChange(async (value) => {
                    this.plugin.settings.loadingGif = value;
                    await this.plugin.saveSettings();
                });
        });
        loadingGifSetting.addButton(button => button
            .setButtonText('Browse')
            .onClick(async () => {
                const files = this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'gif');
                if (files.length === 0) {
                    new Notice('No GIF files found in your vault. Add a .gif file to your vault first.');
                    return;
                }
                const modal = new FileSuggestModal(this.app, files, async (file) => {
                    this.plugin.settings.loadingGif = file.path;
                    loadingGifInput.setValue(file.path);
                    await this.plugin.saveSettings();
                });
                modal.open();
            }));

        // Auto-hide header toggle
        new Setting(containerEl)
            .setName('Auto-hide header')
            .setDesc('Automatically hide the header bar')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoHideHeader)
                .onChange(async (value) => {
                    this.plugin.settings.autoHideHeader = value;
                    await this.plugin.saveSettings();
                    // Update all chat views with auto-hide setting
                    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                        const chatView = leaf.view as StellaChatView;
                        if (chatView && chatView.updateHeaderVisibility) {
                            chatView.updateHeaderVisibility();
                        }
                    });
                }));

        new Setting(containerEl)
            .setName('Show Token Count')
            .setDesc('Display estimated token usage during and after response generation')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTokenCount)
                .onChange(async (value) => {
                    this.plugin.settings.showTokenCount = value;
                    await this.plugin.saveSettings();
                }));

        // QuickAdd Integration settings
        new Setting(containerEl)
            .setName('QuickAdd Commands')
            .setDesc('Configure right-click context menu options that trigger QuickAdd commands')
            .addButton(button => button
                .setButtonText('Show Available Commands')
                .onClick(() => {
                    this.showAvailableQuickAddCommands();
                }))
            .addButton(button => button
                .setButtonText('Add Command')
                .onClick(() => {
                    this.plugin.settings.quickAddCommands.push({
                        id: `command-${Date.now()}`,
                        name: 'New Command',
                        description: 'Description for new command'
                    });
                    this.plugin.saveSettings();
                    this.display(); // Refresh to show new command
                }));

        // Display existing QuickAdd commands
        this.plugin.settings.quickAddCommands.forEach((command, index) => {
            const commandContainer = containerEl.createDiv('quickadd-command-item');

            new Setting(commandContainer)
                .setName(`Command ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('Command Name')
                    .setValue(command.name)
                    .onChange(async (value) => {
                        this.plugin.settings.quickAddCommands[index].name = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('QuickAdd Command ID (click "Show Available Commands" for help)')
                    .setValue(command.id)
                    .onChange(async (value) => {
                        this.plugin.settings.quickAddCommands[index].id = value;
                        await this.plugin.saveSettings();
                    }))
                .addTextArea(text => text
                    .setPlaceholder('Description')
                    .setValue(command.description)
                    .onChange(async (value) => {
                        this.plugin.settings.quickAddCommands[index].description = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(button => button
                    .setButtonText('Remove')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.quickAddCommands.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display(); // Refresh to remove the deleted command
                    }));
        });

        // MCP (Model Context Protocol) Settings Section
        containerEl.createEl('h2', { text: 'MCP (Model Context Protocol)' });

        new Setting(containerEl)
            .setName('Enable MCP')
            .setDesc('Enable Model Context Protocol for connecting to external tools and data sources')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.mcpEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.mcpEnabled = value;
                    await this.plugin.saveSettings();
                    if (value && this.plugin.settings.mcpServers.length > 0) {
                        await this.plugin.initializeMCPServers();
                    }
                    this.display(); // Refresh to show/hide MCP server settings
                }));

        if (this.plugin.settings.mcpEnabled) {
            new Setting(containerEl)
                .setName('Auto-discovery')
                .setDesc('Automatically discover MCP servers on the network')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.mcpAutoDiscovery)
                    .onChange(async (value) => {
                        this.plugin.settings.mcpAutoDiscovery = value;
                        await this.plugin.saveSettings();
                    }));

            // Add Server Button
            new Setting(containerEl)
                .setName('Add MCP Server')
                .setDesc('Configure connections to MCP servers')
                .addButton(button => button
                    .setButtonText('Add Server')
                    .onClick(() => {
                        this.showMCPServerModal();
                    }));

            // Display existing servers
            this.plugin.settings.mcpServers.forEach((server, index) => {
                const serverSetting = new Setting(containerEl);

                const serverInfo = serverSetting.settingEl.createDiv('mcp-server-info');
                serverInfo.style.display = 'flex';
                serverInfo.style.alignItems = 'center';
                serverInfo.style.gap = '10px';
                serverInfo.style.width = '100%';

                // Status indicator
                const statusDot = serverInfo.createSpan('mcp-status-dot');
                statusDot.style.width = '8px';
                statusDot.style.height = '8px';
                statusDot.style.borderRadius = '50%';
                statusDot.style.backgroundColor = server.connected ? '#4ade80' : '#ef4444';

                // Server details
                const serverDetails = serverInfo.createDiv();
                serverDetails.createEl('strong', { text: server.name });
                serverDetails.createEl('br');
                serverDetails.createEl('small', {
                    text: `${server.transport} - ${server.endpoint || server.command}`,
                    attr: { style: 'color: var(--text-muted);' }
                });

                // Action buttons
                const actions = serverInfo.createDiv();
                actions.style.marginLeft = 'auto';
                actions.style.display = 'flex';
                actions.style.gap = '8px';

                // Connect/Disconnect button
                const connectBtn = actions.createEl('button', {
                    text: server.connected ? 'Disconnect' : 'Connect',
                    cls: 'mod-cta'
                });
                connectBtn.onclick = async () => {
                    if (server.connected) {
                        await this.plugin.mcp.removeServer(server.id);
                    } else {
                        await this.plugin.mcp.addServer(server);
                    }
                    this.display(); // Refresh to update status
                };

                // Edit button
                const editBtn = actions.createEl('button', { text: 'Edit' });
                editBtn.onclick = () => {
                    this.showMCPServerModal(server, index);
                };

                // Remove button
                const removeBtn = actions.createEl('button', {
                    text: 'Remove',
                    cls: 'mod-warning'
                });
                removeBtn.onclick = async () => {
                    await this.plugin.mcp.removeServer(server.id);
                    this.plugin.settings.mcpServers.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to remove the server
                };
            });

            // Show MCP status if servers are configured
            if (this.plugin.settings.mcpServers.length > 0) {
                const connectedServers = this.plugin.mcp.getConnectedServers();
                const totalTools = this.plugin.mcp.getAllTools().length;
                const totalResources = this.plugin.mcp.getAllResources().length;

                const statusSetting = new Setting(containerEl);
                const statusDiv = statusSetting.settingEl.createDiv('mcp-status');
                statusDiv.innerHTML = `
                    <strong>MCP Status:</strong><br>
                    Connected Servers: ${connectedServers.length}/${this.plugin.settings.mcpServers.length}<br>
                    Available Tools: ${totalTools}<br>
                    Available Resources: ${totalResources}
                `;
            }
        }
    }

    modelSetting: Setting;
    modelDropdown: any;

    async fetchModelsForProvider(provider: string): Promise<string[]> {
        try {
            switch (provider) {
                case 'openai':
                    return await this.fetchOpenAIModels();
                case 'anthropic':
                    return await this.fetchAnthropicModels();
                case 'google':
                    return await this.fetchGoogleModels();
                case 'ollama':
                    return await this.fetchOllamaModels();
                case 'lmstudio':
                    return await this.fetchLMStudioModels();
                case 'openrouter':
                    return await listOpenRouterModels();
                case 'openclaw':
                    // Auto-set model for OpenClaw (only one option)
                    if (!this.plugin.settings.model || this.plugin.settings.model === '') {
                        this.plugin.settings.model = 'openclaw:main';
                        await this.plugin.saveSettings();
                    }
                    return ['openclaw:main'];
                case 'hermes': {
                    // Hermes routes models itself and normally advertises a
                    // single id; select it automatically.
                    const hermesModels = await listHermesModels(this.plugin.settings);
                    if (hermesModels.length > 0 && !hermesModels.includes(this.plugin.settings.model)) {
                        this.plugin.settings.model = hermesModels[0];
                        await this.plugin.saveSettings();
                    }
                    return hermesModels;
                }
                default:
                    return [];
            }
        } catch (error) {
            console.error(`Failed to fetch models for ${provider}:`, error);
            return [];
        }
    }

    async fetchOpenAIModels(): Promise<string[]> {
        if (!this.plugin.settings.openaiApiKey) return [];

        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error('OpenAI API error:', response.status, response.statusText);
                return [];
            }

            const data = await response.json();
            console.log('OpenAI API response:', data);

            if (!data.data) return [];

            // Filter for chat completion models (GPT models)
            return data.data
                .filter((model: any) => {
                    // Include GPT models and other chat-capable models
                    return model.id.includes('gpt') ||
                           model.id.includes('o1') ||
                           model.id.includes('o3');
                })
                .map((model: any) => model.id)
                .sort();
        } catch (error) {
            console.error('Error fetching OpenAI models:', error);
            return [];
        }
    }

    async fetchAnthropicModels(): Promise<string[]> {
        if (!this.plugin.settings.anthropicApiKey) return [];

        try {
            const response = await FetchManager.enhancedFetch('https://api.anthropic.com/v1/models', {
                headers: {
                    'x-api-key': this.plugin.settings.anthropicApiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            if (!response.ok) {
                console.error('Anthropic API error:', response.status, response.statusText);
                return [];
            }

            const data = await response.json();
            console.log('Anthropic API response:', data);

            if (!data.data) return [];

            // Return the model IDs from the API response
            return data.data.map((model: any) => model.id).sort();
        } catch (error) {
            console.error('Error fetching Anthropic models:', error);
            return [];
        }
    }

    async fetchGoogleModels(): Promise<string[]> {
        if (!this.plugin.settings.googleApiKey) return [];

        try {
            // Use the correct Gemini API models endpoint
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.plugin.settings.googleApiKey}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error('Google API error:', response.status, response.statusText);
                return [];
            }

            const data = await response.json();
            console.log('Google API response:', data);

            if (!data.models) return [];

            // Filter for models that support generateContent and extract clean model names
            return data.models
                .filter((model: any) => {
                    return model.supportedGenerationMethods?.includes('generateContent');
                })
                .map((model: any) => {
                    // Remove 'models/' prefix from model name
                    return model.name.replace('models/', '');
                })
                .sort();
        } catch (error) {
            console.error('Error fetching Google models:', error);
            return [];
        }
    }

    async fetchOllamaModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
            if (!response.ok) return [];

            const data = await response.json();
            return data.models?.map((model: any) => model.name) || [];
        } catch (error) {
            console.error('Error fetching Ollama models:', error);
            return [];
        }
    }

    async fetchLMStudioModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.plugin.settings.lmStudioBaseUrl}/v1/models`);
            if (!response.ok) return [];

            const data = await response.json();
            return data.data?.map((model: any) => model.id) || [];
        } catch (error) {
            console.error('Error fetching LM Studio models:', error);
            return [];
        }
    }

    async refreshModelDropdown() {
        if (!this.modelDropdown) {
            console.log('No model dropdown found');
            return;
        }

        console.log(`Refreshing models for provider: ${this.plugin.settings.provider}`);
        console.log('Dropdown object:', this.modelDropdown);
        console.log('Dropdown keys:', Object.keys(this.modelDropdown));

        try {
            const models = await this.fetchModelsForProvider(this.plugin.settings.provider);
            console.log(`Fetched ${models.length} models for ${this.plugin.settings.provider}:`, models);

            // Clear and repopulate dropdown - try different access methods
            const dropdown = this.modelDropdown;

            // Method 1: Direct selectEl access
            if (dropdown.selectEl) {
                console.log('Using selectEl method');
                dropdown.selectEl.empty();

                if (models.length === 0) {
                    dropdown.addOption('', `No ${this.plugin.settings.provider} models found`);
                } else {
                    // A model left over from another provider isn't in this
                    // list; show a prompt instead of silently displaying the
                    // first entry as if it were selected.
                    if (!models.includes(this.plugin.settings.model)) {
                        dropdown.addOption('', 'Pick a model…');
                    }
                    models.forEach(model => {
                        dropdown.addOption(model, model);
                    });
                }

                dropdown.setValue(models.includes(this.plugin.settings.model) ? this.plugin.settings.model : '');
                console.log(`Set dropdown value to: ${this.plugin.settings.model}`);
            }
            // Method 2: Try direct dropdown element access
            else if (dropdown.dropdownEl) {
                console.log('Using dropdownEl method');
                const select = dropdown.dropdownEl;
                select.empty();

                if (models.length === 0) {
                    select.createEl('option', { text: `No ${this.plugin.settings.provider} models found`, value: '' });
                } else {
                    models.forEach(model => {
                        console.log(`Adding model option: ${model}`);
                        select.createEl('option', { text: model, value: model });
                    });
                }

                dropdown.setValue(this.plugin.settings.model);
                console.log(`Set dropdown value to: ${this.plugin.settings.model}`);
            }
            // Method 3: Try recreating the dropdown
            else {
                console.log('Recreating dropdown');
                this.createModelDropdown(models);
            }
        } catch (error) {
            console.error('Error refreshing models:', error);
        }
    }

    createModelDropdown(models: string[]) {
        if (!this.modelSetting) {
            console.error('No model setting found for dropdown creation');
            return;
        }

        console.log('Creating model dropdown, current components:', this.modelSetting.components.length);

        // Completely clear the control element and rebuild
        this.modelSetting.controlEl.empty();
        this.modelSetting.components = [];

        // Create new dropdown
        this.modelDropdown = this.modelSetting.addDropdown(dropdown => {
            if (models.length === 0) {
                dropdown.addOption('', `No ${this.plugin.settings.provider} models found`);
            } else {
                models.forEach(model => {
                    dropdown.addOption(model, model);
                });
            }

            dropdown.setValue(this.plugin.settings.model);
            dropdown.onChange(async (value) => {
                this.plugin.settings.model = value;
                await this.plugin.saveSettings();
                // Update ALL chat views' model info immediately
                this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach(leaf => {
                    const chatView = leaf.view as StellaChatView;
                    if (chatView && chatView.updateModelInfo) {
                        chatView.updateModelInfo(chatView.modelInfoContainer);
                    }
                });
            });
            return dropdown;
        });

        console.log(`Created new dropdown with ${models.length} models, components now:`, this.modelSetting.components.length);
    }

    showAvailableQuickAddCommands() {
        try {
            const commands = (this.app as any).commands;
            if (!commands) {
                new Notice('Commands system not available');
                return;
            }

            const allCommands = commands.listCommands();
            const quickAddCommands = allCommands.filter((cmd: any) => cmd.id.includes('quickadd'));

            if (quickAddCommands.length === 0) {
                new Notice('No QuickAdd commands found. Make sure QuickAdd plugin is installed and configured.');
                return;
            }

            // Create a modal to show available commands
            const modal = new Modal(this.app);
            modal.titleEl.setText('Available QuickAdd Commands');

            const content = modal.contentEl;
            content.createEl('p', { text: 'Copy the Command ID to use in Stella settings:' });

            const container = content.createDiv('quickadd-commands-list');

            quickAddCommands.forEach((cmd: any) => {
                const cmdItem = container.createDiv('quickadd-command-item');
                cmdItem.style.marginBottom = '10px';
                cmdItem.style.padding = '8px';
                cmdItem.style.border = '1px solid var(--background-modifier-border)';
                cmdItem.style.borderRadius = '4px';

                const nameEl = cmdItem.createEl('strong', { text: cmd.name });
                nameEl.style.display = 'block';

                const idEl = cmdItem.createEl('code', { text: cmd.id });
                idEl.style.display = 'block';
                idEl.style.marginTop = '4px';
                idEl.style.fontSize = '12px';
                idEl.style.color = 'var(--text-muted)';

                // Make the command ID selectable and copyable
                idEl.style.cursor = 'pointer';
                idEl.addEventListener('click', () => {
                    navigator.clipboard.writeText(cmd.id);
                    new Notice(`Copied: ${cmd.id}`);
                });
            });

            const buttonContainer = content.createDiv();
            buttonContainer.style.marginTop = '16px';
            buttonContainer.style.textAlign = 'right';

            const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
            closeBtn.onclick = () => modal.close();

            modal.open();

        } catch (error) {
            new Notice('Failed to retrieve QuickAdd commands');
            console.error('Error showing QuickAdd commands:', error);
        }
    }

    showMCPServerModal(server?: MCPServer, index?: number) {
        const modal = new Modal(this.app);
        modal.titleEl.setText(server ? 'Edit MCP Server' : 'Add MCP Server');

        const content = modal.contentEl;

        // Server configuration form
        let selectedTransport = server?.transport || 'stdio';
        let nameInput: HTMLInputElement;
        let commandInput: HTMLInputElement;
        let argsInput: HTMLInputElement;
        let endpointInput: HTMLInputElement;
        let envContainer: HTMLElement;

        // Server name
        const nameContainer = content.createDiv();
        nameContainer.createEl('label', { text: 'Server Name' });
        nameInput = nameContainer.createEl('input', {
            type: 'text',
            value: server?.name || '',
            attr: { placeholder: 'e.g., My Custom MCP Server' }
        });
        nameInput.style.width = '100%';
        nameInput.style.marginTop = '4px';

        // Transport toggle (simplified)
        const transportContainer = content.createDiv();
        transportContainer.style.marginTop = '16px';
        transportContainer.createEl('label', { text: 'Server Type' });

        const transportToggle = transportContainer.createDiv();
        transportToggle.style.marginTop = '8px';
        transportToggle.style.display = 'flex';
        transportToggle.style.gap = '12px';

        const stdioOption = transportToggle.createEl('label');
        stdioOption.style.cursor = 'pointer';
        stdioOption.style.display = 'flex';
        stdioOption.style.alignItems = 'center';
        stdioOption.style.gap = '6px';
        const stdioRadio = stdioOption.createEl('input', { type: 'radio', value: 'stdio' });
        stdioRadio.name = 'transport';
        stdioRadio.checked = selectedTransport === 'stdio';
        stdioOption.createSpan({ text: 'Local Server (like Claude Desktop)' });

        const httpOption = transportToggle.createEl('label');
        httpOption.style.cursor = 'pointer';
        httpOption.style.display = 'flex';
        httpOption.style.alignItems = 'center';
        httpOption.style.gap = '6px';
        const httpRadio = httpOption.createEl('input', { type: 'radio', value: 'http' });
        httpRadio.name = 'transport';
        httpRadio.checked = selectedTransport === 'http';
        httpOption.createSpan({ text: 'Remote Server (WebSocket)' });

        // Configuration container
        const configContainer = content.createDiv();
        configContainer.style.marginTop = '16px';

        const updateConfig = () => {
            configContainer.empty();

            if (selectedTransport === 'stdio') {
                // Command
                configContainer.createEl('label', { text: 'Command' });
                commandInput = configContainer.createEl('input', {
                    type: 'text',
                    value: server?.command || 'npx',
                    attr: { placeholder: 'npx' }
                });
                commandInput.style.width = '100%';
                commandInput.style.marginTop = '4px';

                // Arguments
                const argsLabel = configContainer.createEl('label', { text: 'Arguments' });
                argsLabel.style.marginTop = '12px';
                argsLabel.style.display = 'block';
                argsInput = configContainer.createEl('input', {
                    type: 'text',
                    value: server?.args?.join(' ') || '',
                    attr: { placeholder: '-y @modelcontextprotocol/server-filesystem /path/to/files' }
                });
                argsInput.style.width = '100%';
                argsInput.style.marginTop = '4px';

                // Environment Variables
                const envLabel = configContainer.createEl('label', { text: 'Environment Variables (optional)' });
                envLabel.style.marginTop = '12px';
                envLabel.style.display = 'block';

                envContainer = configContainer.createDiv();
                envContainer.style.marginTop = '8px';

                // Add existing env vars
                if (server?.env) {
                    Object.entries(server.env).forEach(([key, value]) => {
                        addEnvVar(key, value);
                    });
                }

                // Add button
                const addEnvBtn = configContainer.createEl('button', { text: '+ Add Environment Variable' });
                addEnvBtn.style.marginTop = '8px';
                addEnvBtn.onclick = (e) => {
                    e.preventDefault();
                    addEnvVar();
                };

            } else {
                // WebSocket endpoint
                configContainer.createEl('label', { text: 'WebSocket Endpoint' });
                endpointInput = configContainer.createEl('input', {
                    type: 'url',
                    value: server?.endpoint || '',
                    attr: { placeholder: 'wss://your-mcp-server.com/mcp' }
                });
                endpointInput.style.width = '100%';
                endpointInput.style.marginTop = '4px';
            }
        };

        const addEnvVar = (key = '', value = '') => {
            const envRow = envContainer.createDiv();
            envRow.style.display = 'flex';
            envRow.style.gap = '8px';
            envRow.style.marginBottom = '8px';
            envRow.style.alignItems = 'center';

            const keyInput = envRow.createEl('input', {
                type: 'text',
                value: key,
                attr: { placeholder: 'VARIABLE_NAME' }
            });
            keyInput.style.flex = '1';
            keyInput.dataset.envKey = 'true';

            const valueInput = envRow.createEl('input', {
                type: 'text',
                value: value,
                attr: { placeholder: 'value' }
            });
            valueInput.style.flex = '2';
            valueInput.dataset.envValue = 'true';

            const removeBtn = envRow.createEl('button', { text: '×' });
            removeBtn.style.width = '30px';
            removeBtn.style.height = '30px';
            removeBtn.style.borderRadius = '4px';
            removeBtn.onclick = (e) => {
                e.preventDefault();
                envRow.remove();
            };
        };

        stdioRadio.onchange = () => {
            selectedTransport = 'stdio';
            updateConfig();
        };

        httpRadio.onchange = () => {
            selectedTransport = 'http';
            updateConfig();
        };

        updateConfig();

        // Buttons
        const buttonContainer = content.createDiv();
        buttonContainer.style.marginTop = '24px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => modal.close();

        const saveBtn = buttonContainer.createEl('button', {
            text: server ? 'Update' : 'Add',
            cls: 'mod-cta'
        });

        saveBtn.onclick = async () => {
            const name = nameInput.value.trim();
            if (!name) {
                new Notice('Server name is required');
                return;
            }

            const newServer: MCPServer = {
                id: server?.id || `mcp-${Date.now()}`,
                name,
                transport: selectedTransport,
                connected: false
            };

            if (selectedTransport === 'stdio') {
                newServer.command = commandInput.value.trim() || 'npx';
                newServer.args = argsInput.value.trim() ?
                    argsInput.value.trim().split(' ').filter(arg => arg.length > 0) : [];

                // Collect environment variables
                const envVars: Record<string, string> = {};
                const keyInputs = envContainer.querySelectorAll('[data-env-key]') as NodeListOf<HTMLInputElement>;
                const valueInputs = envContainer.querySelectorAll('[data-env-value]') as NodeListOf<HTMLInputElement>;

                keyInputs.forEach((keyInput, i) => {
                    const key = keyInput.value.trim();
                    const value = valueInputs[i]?.value.trim();
                    if (key && value) {
                        envVars[key] = value;
                    }
                });

                if (Object.keys(envVars).length > 0) {
                    newServer.env = envVars;
                }
            } else {
                const endpoint = endpointInput.value.trim();
                if (!endpoint) {
                    new Notice('WebSocket endpoint is required');
                    return;
                }
                newServer.endpoint = endpoint;
            }

            try {
                if (server && typeof index === 'number') {
                    this.plugin.settings.mcpServers[index] = newServer;
                } else {
                    this.plugin.settings.mcpServers.push(newServer);
                }

                await this.plugin.saveSettings();

                if (this.plugin.settings.mcpEnabled) {
                    await this.plugin.mcp.addServer(newServer);
                }

                new Notice(`MCP server ${server ? 'updated' : 'added'}: ${name}`);
                modal.close();
                this.display();
            } catch (error) {
                new Notice(`Failed to ${server ? 'update' : 'add'} MCP server`);
                console.error('MCP server error:', error);
            }
        };

        modal.open();
    }

    showMCPTemplateConfigModal(template: MCPServerTemplate) {
        const modal = new Modal(this.app);
        modal.titleEl.setText(`Configure ${template.name} Server`);

        const content = modal.contentEl;

        content.createEl('p', {
            text: template.description,
            attr: { style: 'color: var(--text-muted); margin-bottom: 16px;' }
        });

        // Show command info
        const commandInfo = content.createDiv();
        commandInfo.style.marginBottom = '20px';
        commandInfo.style.padding = '12px';
        commandInfo.style.backgroundColor = 'var(--background-secondary)';
        commandInfo.style.borderRadius = '8px';

        commandInfo.createEl('strong', { text: 'Command:' }).style.display = 'block';
        commandInfo.createEl('code', { text: `${template.command} ${template.args.join(' ')}` });

        // Environment variables form
        const envInputs: Record<string, HTMLInputElement> = {};

        if (template.envVariables.length > 0) {
            content.createEl('h4', { text: 'Configuration' });

            template.envVariables.forEach(envVar => {
                const container = content.createDiv();
                container.style.marginBottom = '16px';

                const label = container.createEl('label', { text: envVar.description });
                if (envVar.required) {
                    label.createSpan({ text: ' *', attr: { style: 'color: var(--text-error);' } });
                }

                const input = container.createEl('input', {
                    type: envVar.key.toLowerCase().includes('token') || envVar.key.toLowerCase().includes('key') ? 'password' : 'text',
                    attr: { placeholder: envVar.placeholder || '' }
                });
                input.style.width = '100%';
                input.style.marginTop = '4px';

                envInputs[envVar.key] = input;
            });
        }

        // Buttons
        const buttonContainer = content.createDiv();
        buttonContainer.style.marginTop = '24px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => modal.close();

        const addBtn = buttonContainer.createEl('button', {
            text: 'Add Server',
            cls: 'mod-cta'
        });

        addBtn.onclick = async () => {
            // Validate required fields
            for (const envVar of template.envVariables) {
                if (envVar.required && !envInputs[envVar.key].value.trim()) {
                    new Notice(`${envVar.description} is required`);
                    return;
                }
            }

            // Create server config
            const newServer: MCPServer = {
                id: `mcp-${Date.now()}`,
                name: template.name,
                transport: 'stdio',
                command: template.command,
                args: [...template.args],
                connected: false
            };

            // Add environment variables
            const env: Record<string, string> = {};
            Object.entries(envInputs).forEach(([key, input]) => {
                const value = input.value.trim();
                if (value) {
                    env[key] = value;
                }
            });

            if (Object.keys(env).length > 0) {
                newServer.env = env;
            }

            try {
                this.plugin.settings.mcpServers.push(newServer);
                await this.plugin.saveSettings();

                if (this.plugin.settings.mcpEnabled) {
                    await this.plugin.mcp.addServer(newServer);
                }

                new Notice(`Added ${template.name} MCP server`);
                modal.close();
                this.display();
            } catch (error) {
                new Notice(`Failed to add ${template.name} server`);
                console.error('Template server error:', error);
            }
        };

        modal.open();
    }
}