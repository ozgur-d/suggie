# ✨ Suggie

> A VS Code extension that turns your local Claude Code CLI into context-aware inline code suggestions.

---

## 🚀 Features

- **Inline Completions** — Get intelligent code suggestions directly in your editor, powered by Claude's language models through the local CLI.
- **Model Selection** — Choose between Haiku (fast), Sonnet (balanced), and Opus (accurate) to match your workflow.
- **Multi-Signal Context** — Suggie collects context from the current file, open tabs, recent edits, file navigation history, and past completion feedback to build richer prompts.
- **Feedback Loop** — Accepted and rejected completions are tracked per session and fed back into subsequent prompts, so suggestions improve as you work.
- **Graceful Degradation** — If the persistent CLI subprocess drops, Suggie falls back to one-shot invocations automatically. If the CLI is missing entirely, you get a clear status bar indicator instead of silent failures.

## 🔍 How It Works

1. **Persistent CLI Subprocess** — Suggie spawns a long-lived `claude` process using `--input-format stream-json` and `--output-format stream-json`. All completion requests are multiplexed through this single process, eliminating per-request startup overhead.
2. **Context Priming** — When you switch to a file, Suggie sends its full content to the subprocess as a context-prime message. Subsequent completion requests for the same file only send a small cursor-vicinity window, relying on the conversation history already held by the CLI.
3. **Prompt Caching** — The combination of persistent-process conversation history and context priming means Claude's prompt cache stays warm. Repeated completions in the same file hit cached prefixes, reducing latency and cost.

## 📦 Installation / Getting Started

1. **Install the Claude Code CLI** — Follow the instructions at [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to install and authenticate the CLI. Verify it works by running `claude --version` in your terminal.
2. **Install the Extension** — Search for **Suggie** in the VS Code Extensions Marketplace, or install the `.vsix` file directly:
   ```
   code --install-extension suggie-0.1.0.vsix
   ```
3. **Start Coding** — Open any file. Suggie activates automatically and starts providing inline suggestions. Look for **Suggie: Ready** in the status bar.

## ⚙️ Configuration

All settings live under the `suggie.*` namespace in VS Code settings.

| Setting | Type | Default | Description |
|---|---|---|---|
| `suggie.model` | `string` | `"sonnet"` | Model tier: `"haiku"`, `"sonnet"`, or `"opus"` |
| `suggie.enabled` | `boolean` | `true` | Enable or disable inline completions |
| `suggie.cliPath` | `string` | `""` | Custom path to the Claude Code CLI binary (leave empty to auto-detect from PATH) |
| `suggie.excludePatterns` | `string[]` | `[".env", "*.key", "*.pem", "*credentials*", "*.secret"]` | Glob patterns for files excluded from context collection |

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+I` (`Cmd+Alt+I` on macOS) | Manually trigger an inline completion at the cursor |

You can also run **Suggie: Toggle** from the Command Palette to enable or disable completions, or click the status bar item.

## 🏗️ Architecture Overview

```
src/
├── extension.ts                  # Activation, status bar, command registration
├── models/
│   ├── types.ts                  # Shared types, model configs
│   └── configuration.ts          # Reads VS Code settings (suggie.*)
├── providers/
│   └── inlineCompletionProvider.ts  # VS Code InlineCompletionItemProvider
├── services/
│   ├── cliService.ts             # Persistent CLI subprocess management, prompt building
│   ├── contextCollector.ts       # Gathers multi-signal context (tabs, edits, navigation)
│   ├── contextPrimingService.ts  # Proactive file priming and update queue
│   └── sessionState.ts           # Edit history, file switches, feedback tracking
└── utils/
    ├── contextBudget.ts          # Token budget enforcement across context signals
    └── debouncer.ts              # Adaptive debounce for automatic triggers
```

The extension follows a clear separation: **models** define data structures and config access, **services** handle the CLI interaction and context management, **providers** implement the VS Code API contract, and **utils** provide shared helpers.

## 📋 Requirements

- **VS Code** 1.75 or later
- **Claude Code CLI** installed and authenticated (available in your PATH, or configured via `suggie.cliPath`)

## 🤝 Contributing

Contributions are welcome! To get started:

```bash
git clone https://github.com/ozgur-d/suggie.git
cd suggie
npm install
npm run build
```

Open the project in VS Code and press `F5` to launch an Extension Development Host with Suggie loaded.

## 📄 License

[MIT](LICENSE)
