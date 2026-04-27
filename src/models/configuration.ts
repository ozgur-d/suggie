import * as vscode from 'vscode';
import { ModelTier, ModelConfig, MODEL_CONFIGS } from './types';

export class ConfigurationManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('suggie')) {
          this.changeEmitter.fire();
        }
      })
    );
    this.disposables.push(this.changeEmitter);
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('suggie');
  }

  getModel(): ModelTier {
    return (this.config.get<string>('model') as ModelTier) ?? 'sonnet';
  }

  getModelConfig(): ModelConfig {
    const model = this.getModel();
    return { model, ...MODEL_CONFIGS[model] };
  }

  isEnabled(): boolean {
    return this.config.get<boolean>('enabled') ?? true;
  }

  getCliPath(): string {
    return this.config.get<string>('cliPath') ?? '';
  }

  getExcludePatterns(): string[] {
    return this.config.get<string[]>('excludePatterns') ?? [
      '.env',
      '*.key',
      '*.pem',
      '*credentials*',
      '*.secret',
    ];
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
