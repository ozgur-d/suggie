import * as vscode from 'vscode';
import { CliService } from './services/cliService';
import { SessionState } from './services/sessionState';
import { ContextCollector } from './services/contextCollector';
import { ContextPrimingService } from './services/contextPrimingService';
import { CompletionCache } from './services/completionCache';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { ConfigurationManager } from './models/configuration';
import { Debouncer } from './utils/debouncer';

type StatusBarState = 'active' | 'loading' | 'disabled' | 'cliMissing' | 'error';

let statusBarItem: vscode.StatusBarItem;
let providerDisposable: vscode.Disposable | null = null;
let lastCliCheckTime = 0;
const CLI_RECHECK_INTERVAL_MS = 30_000;

function updateStatusBar(
  state: StatusBarState,
  config: ConfigurationManager,
  detail?: string
): void {
  switch (state) {
    case 'active':
      statusBarItem.text = '$(check) Suggie: Ready';
      statusBarItem.tooltip = `Suggie — Model: ${config.getModel()}`;
      statusBarItem.command = 'suggie.toggle';
      break;
    case 'loading':
      statusBarItem.text = '$(loading~spin) Suggie: ...';
      statusBarItem.tooltip = 'Suggie — Generating...';
      statusBarItem.command = undefined;
      break;
    case 'disabled':
      statusBarItem.text = '$(circle-slash) Suggie: Off';
      statusBarItem.tooltip = 'Suggie — Disabled';
      statusBarItem.command = 'suggie.toggle';
      break;
    case 'cliMissing':
      statusBarItem.text = '$(warning) Suggie: No CLI';
      statusBarItem.tooltip = 'Claude Code CLI not found';
      statusBarItem.command = 'workbench.action.openSettings';
      break;
    case 'error':
      statusBarItem.text = '$(error) Suggie: Error';
      statusBarItem.tooltip = `Suggie — ${detail ?? 'Unknown error'}`;
      statusBarItem.command = undefined;
      break;
  }
}

function registerProvider(
  context: vscode.ExtensionContext,
  provider: InlineCompletionProvider
): void {
  if (providerDisposable) {
    providerDisposable.dispose();
  }
  providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider
  );
  context.subscriptions.push(providerDisposable);
}

async function tryRecoverCli(
  cliService: CliService,
  config: ConfigurationManager
): Promise<boolean> {
  const now = Date.now();
  if (now - lastCliCheckTime < CLI_RECHECK_INTERVAL_MS) {
    return cliService.getLastDetection()?.available ?? false;
  }
  lastCliCheckTime = now;
  const detection = await cliService.detectCli();
  if (detection.available) {
    updateStatusBar('active', config);
  }
  return detection.available;
}

export async function activate(context: vscode.ExtensionContext) {
  const config = new ConfigurationManager();
  context.subscriptions.push(config);

  statusBarItem = vscode.window.createStatusBarItem(
    'suggie.status',
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const outputChannel = vscode.window.createOutputChannel('Suggie');
  context.subscriptions.push(outputChannel);

  const cliService = new CliService();
  cliService.setOutputChannel(outputChannel);
  cliService.setCliPath(config.getCliPath());

  const debouncer = new Debouncer(() => config.getModelConfig().debounceMs);
  context.subscriptions.push(debouncer);

  const sessionState = new SessionState();
  sessionState.startTracking();
  context.subscriptions.push(sessionState);

  const contextCollector = new ContextCollector(
    sessionState,
    () => config.getExcludePatterns()
  );

  const primingService = new ContextPrimingService(
    cliService,
    () => config.getModel(),
    () => config.getExcludePatterns()
  );
  primingService.setOutputChannel(outputChannel);
  context.subscriptions.push(primingService);

  const onStatusChange = (loading: boolean) => {
    if (loading) {
      updateStatusBar('loading', config);
    } else {
      updateStatusBar('active', config);
    }
  };

  const completionCache = new CompletionCache();

  const provider = new InlineCompletionProvider(
    cliService,
    debouncer,
    () => config.getModel(),
    onStatusChange,
    contextCollector,
    sessionState,
    primingService,
    completionCache
  );

  // Detect CLI at activation
  lastCliCheckTime = Date.now();
  const detection = await cliService.detectCli();
  if (!detection.available) {
    updateStatusBar('cliMissing', config);
  } else if (!config.isEnabled()) {
    updateStatusBar('disabled', config);
  } else {
    primingService.startTracking();
    registerProvider(context, provider);
    updateStatusBar('active', config);
  }

  // Toggle command
  context.subscriptions.push(
    vscode.commands.registerCommand('suggie.toggle', async () => {
      const wsConfig = vscode.workspace.getConfiguration('suggie');
      const current = wsConfig.get<boolean>('enabled') ?? true;
      await wsConfig.update('enabled', !current, vscode.ConfigurationTarget.Global);
    })
  );

  // Manual trigger command
  context.subscriptions.push(
    vscode.commands.registerCommand('suggie.triggerCompletion', () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    })
  );

  // Accepted completion tracking (US4 feedback)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'suggie.acceptedCompletion',
      (requestId: string, text: string) => {
        sessionState.recordFeedback(requestId, 'accepted', text);
      }
    )
  );

  // Config change listener (US2 + US5)
  context.subscriptions.push(
    config.onDidChange(async () => {
      cliService.setCliPath(config.getCliPath());

      if (!config.isEnabled()) {
        if (providerDisposable) {
          providerDisposable.dispose();
          providerDisposable = null;
        }
        updateStatusBar('disabled', config);
        return;
      }

      const available = await tryRecoverCli(cliService, config);
      if (!available) {
        updateStatusBar('cliMissing', config);
        return;
      }

      if (!providerDisposable) {
        registerProvider(context, provider);
      }
      updateStatusBar('active', config);
    })
  );
}

export function deactivate() {
  // All disposables cleaned up via context.subscriptions
}
