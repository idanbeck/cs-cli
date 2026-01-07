// Debug console for CS-CLI
// Toggle with ~ key, shows logs and allows commands

export interface ConsoleMessage {
  timestamp: number;
  type: 'info' | 'warn' | 'error' | 'debug' | 'command' | 'result';
  text: string;
}

export type ConsoleCommand = (args: string[]) => string | void;

export class GameConsole {
  private messages: ConsoleMessage[] = [];
  private maxMessages: number = 100;
  private isOpen: boolean = false;
  private inputBuffer: string = '';
  private commands: Map<string, ConsoleCommand> = new Map();
  private commandHistory: string[] = [];
  private historyIndex: number = -1;
  private scrollOffset: number = 0;

  // Callbacks for external state changes
  private onSetCvar?: (name: string, value: string) => void;

  constructor() {
    this.registerBuiltinCommands();
  }

  private registerBuiltinCommands(): void {
    this.registerCommand('help', () => {
      const cmds = Array.from(this.commands.keys()).sort().join(', ');
      return `Available commands: ${cmds}`;
    });

    this.registerCommand('clear', () => {
      this.messages = [];
      return 'Console cleared';
    });

    this.registerCommand('echo', (args) => {
      return args.join(' ');
    });

    this.registerCommand('list', () => {
      return this.messages
        .slice(-10)
        .map(m => `[${m.type}] ${m.text}`)
        .join('\n');
    });
  }

  registerCommand(name: string, handler: ConsoleCommand): void {
    this.commands.set(name.toLowerCase(), handler);
  }

  setOnCvarChange(callback: (name: string, value: string) => void): void {
    this.onSetCvar = callback;
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.inputBuffer = '';
      this.historyIndex = -1;
      this.scrollOffset = 0;
    }
  }

  open(): void {
    this.isOpen = true;
    this.inputBuffer = '';
    this.historyIndex = -1;
  }

  close(): void {
    this.isOpen = false;
  }

  getIsOpen(): boolean {
    return this.isOpen;
  }

  // Log methods
  log(text: string): void {
    this.addMessage('info', text);
  }

  warn(text: string): void {
    this.addMessage('warn', text);
  }

  error(text: string): void {
    this.addMessage('error', text);
  }

  debug(text: string): void {
    this.addMessage('debug', text);
  }

  private addMessage(type: ConsoleMessage['type'], text: string): void {
    this.messages.push({
      timestamp: Date.now(),
      type,
      text
    });

    // Trim old messages
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  // Input handling
  handleKey(key: string): boolean {
    if (!this.isOpen) return false;

    if (key === '\r' || key === '\n') {
      // Execute command
      this.executeInput();
      return true;
    }

    if (key === '\x7f' || key === '\b') {
      // Backspace
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return true;
    }

    if (key === '\x1b[A') {
      // Up arrow - history
      if (this.commandHistory.length > 0) {
        if (this.historyIndex < this.commandHistory.length - 1) {
          this.historyIndex++;
          this.inputBuffer = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
        }
      }
      return true;
    }

    if (key === '\x1b[B') {
      // Down arrow - history
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.inputBuffer = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
      } else if (this.historyIndex === 0) {
        this.historyIndex = -1;
        this.inputBuffer = '';
      }
      return true;
    }

    if (key === '\x1b[5~') {
      // Page up - scroll
      this.scrollOffset = Math.min(this.scrollOffset + 5, Math.max(0, this.messages.length - 10));
      return true;
    }

    if (key === '\x1b[6~') {
      // Page down - scroll
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
      return true;
    }

    // Regular character
    if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
      this.inputBuffer += key;
      return true;
    }

    return true; // Consume all input when console is open
  }

  private executeInput(): void {
    const input = this.inputBuffer.trim();
    this.inputBuffer = '';

    if (!input) return;

    // Add to history
    this.commandHistory.push(input);
    if (this.commandHistory.length > 50) {
      this.commandHistory.shift();
    }
    this.historyIndex = -1;

    // Log the command
    this.addMessage('command', `> ${input}`);

    // Parse command
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Check for built-in commands
    const handler = this.commands.get(cmd);
    if (handler) {
      try {
        const result = handler(args);
        if (result) {
          this.addMessage('result', result);
        }
      } catch (err) {
        this.addMessage('error', `Error: ${err}`);
      }
      return;
    }

    // Check for cvar set (name value)
    if (args.length >= 1 && this.onSetCvar) {
      this.onSetCvar(cmd, args.join(' '));
      this.addMessage('result', `Set ${cmd} = ${args.join(' ')}`);
      return;
    }

    this.addMessage('error', `Unknown command: ${cmd}`);
  }

  // Get messages for display
  getMessages(): ConsoleMessage[] {
    return this.messages;
  }

  getVisibleMessages(maxLines: number): ConsoleMessage[] {
    const start = Math.max(0, this.messages.length - maxLines - this.scrollOffset);
    const end = this.messages.length - this.scrollOffset;
    return this.messages.slice(start, end);
  }

  getInputBuffer(): string {
    return this.inputBuffer;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  // Render console overlay
  render(screenWidth: number, screenHeight: number): string[] {
    if (!this.isOpen) return [];

    const lines: string[] = [];
    const consoleHeight = Math.floor(screenHeight * 0.4); // 40% of screen
    const contentWidth = screenWidth - 4;

    // Header
    lines.push('\x1b[48;5;235m\x1b[38;5;250m' + '─'.repeat(screenWidth) + '\x1b[0m');
    lines.push('\x1b[48;5;235m\x1b[38;5;220m CS-CLI Console (~ to close, PageUp/Down to scroll) ' + ' '.repeat(Math.max(0, screenWidth - 54)) + '\x1b[0m');
    lines.push('\x1b[48;5;235m\x1b[38;5;250m' + '─'.repeat(screenWidth) + '\x1b[0m');

    // Messages
    const visibleMessages = this.getVisibleMessages(consoleHeight - 5);
    for (const msg of visibleMessages) {
      let color = '37'; // white
      let prefix = '';
      switch (msg.type) {
        case 'error': color = '31'; prefix = '[ERROR] '; break;
        case 'warn': color = '33'; prefix = '[WARN] '; break;
        case 'debug': color = '36'; prefix = '[DEBUG] '; break;
        case 'command': color = '32'; prefix = ''; break;
        case 'result': color = '37'; prefix = ''; break;
        default: color = '37'; prefix = ''; break;
      }

      const text = prefix + msg.text;
      const truncated = text.length > contentWidth ? text.slice(0, contentWidth - 3) + '...' : text;
      lines.push(`\x1b[48;5;235m\x1b[${color}m ${truncated}${' '.repeat(Math.max(0, screenWidth - truncated.length - 2))}\x1b[0m`);
    }

    // Pad remaining lines
    while (lines.length < consoleHeight - 1) {
      lines.push('\x1b[48;5;235m' + ' '.repeat(screenWidth) + '\x1b[0m');
    }

    // Input line
    const prompt = '> ';
    const inputDisplay = this.inputBuffer.slice(-(contentWidth - prompt.length - 2));
    const cursor = '█';
    lines.push('\x1b[48;5;235m\x1b[38;5;46m' + prompt + inputDisplay + cursor + ' '.repeat(Math.max(0, screenWidth - prompt.length - inputDisplay.length - 1 - 1)) + '\x1b[0m');

    // Bottom border
    lines.push('\x1b[48;5;235m\x1b[38;5;250m' + '─'.repeat(screenWidth) + '\x1b[0m');

    return lines;
  }
}

// Singleton instance
let consoleInstance: GameConsole | null = null;

export function getGameConsole(): GameConsole {
  if (!consoleInstance) {
    consoleInstance = new GameConsole();
  }
  return consoleInstance;
}

// Convenience logging functions
export function consoleLog(text: string): void {
  getGameConsole().log(text);
}

export function consoleWarn(text: string): void {
  getGameConsole().warn(text);
}

export function consoleError(text: string): void {
  getGameConsole().error(text);
}

export function consoleDebug(text: string): void {
  getGameConsole().debug(text);
}
