/**
 * Pubspec 版本检查器 —— 扩展入口。
 *
 * 功能：
 * - 解析工作区根目录 pubspec.yaml 的依赖（dependencies / dev_dependencies / dependency_overrides）
 * - 读取 pubspec.lock 获取当前安装版本
 * - 查询 pub.dev 最新版本并对比
 * - 可视化提示：CodeLens、版本号装饰、问题面板诊断、状态栏、活动栏树视图、hover
 * - 命令：一键更新约束 / 复制版本号 / 打开 pub.dev
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { parsePubspec, parseLockfile } from './core/pubspec';
import { analyze, type DependencyStatus } from './core/analyzer';
import { PubDevClient, type LatestInfo } from './core/pubdev';
import { VersionCodeLensProvider } from './ui/codeLensProvider';
import { DependenciesTreeProvider } from './ui/treeProvider';

export function activate(): void {
  const checker = new PubspecChecker();
  checker.activate();
}

interface UiOptions {
  showOnlyOutdated: boolean;
  enableCodeLens: boolean;
  enableDecorations: boolean;
  enableDiagnostics: boolean;
  enableStatusBar: boolean;
}

function readConfig(): UiOptions & { excludes: string[]; cacheTtlSeconds: number; concurrency: number } {
  const cfg = vscode.workspace.getConfiguration('pubcheck');
  return {
    showOnlyOutdated: cfg.get<boolean>('showOnlyOutdated', true),
    enableCodeLens: cfg.get<boolean>('enableCodeLens', true),
    enableDecorations: cfg.get<boolean>('enableDecorations', true),
    enableDiagnostics: cfg.get<boolean>('enableDiagnostics', true),
    enableStatusBar: cfg.get<boolean>('enableStatusBar', true),
    excludes: cfg.get<string[]>('excludePackages', []),
    cacheTtlSeconds: cfg.get<number>('cacheTtlSeconds', 3600),
    concurrency: cfg.get<number>('concurrency', 5),
  };
}

class PubspecChecker implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];

  private client = new PubDevClient();
  private pubspecUri: vscode.Uri | undefined;
  private statuses: DependencyStatus[] = [];

  private readonly diagnostics = vscode.languages.createDiagnosticCollection('pubcheck');
  private readonly codeLensProvider = new VersionCodeLensProvider();
  private readonly treeProvider = new DependenciesTreeProvider();
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private statusBar: vscode.StatusBarItem | undefined;

  private readonly decoOutdated = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(217, 119, 6, 0.18)',
    border: '1px solid rgba(217, 119, 6, 0.55)',
    borderRadius: '3px',
    textDecoration: 'underline dotted #d97706',
    overviewRulerColor: '#d97706',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly decoError = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(220, 38, 38, 0.14)',
    border: '1px solid rgba(220, 38, 38, 0.5)',
    borderRadius: '3px',
    overviewRulerColor: '#dc2626',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  private lastPubspecEditor: vscode.TextEditor | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private checking = false;
  private rerunRequested = false;
  private enabled = true;

  activate(): void {
    const cfg = readConfig();
    this.enabled = cfg.enableCodeLens || cfg.enableDecorations || cfg.enableDiagnostics || cfg.enableStatusBar || vscode.workspace.getConfiguration('pubcheck').get<boolean>('enable', true);
    this.client = new PubDevClient(cfg.cacheTtlSeconds * 1000, cfg.concurrency);

    // CodeLens（用文件名匹配，不依赖 YAML 语言关联）
    this.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ pattern: '**/pubspec.yaml' }, this.codeLensProvider)
    );

    // Hover：在依赖行上显示版本详情
    this.subscriptions.push(
      vscode.languages.registerHoverProvider({ pattern: '**/pubspec.yaml' }, {
        provideHover: (document, position) => this.provideHover(document, position),
      })
    );

    // 树视图
    this.treeView = vscode.window.createTreeView('pubcheck.dependencies', {
      treeDataProvider: this.treeProvider,
    });

    // 状态栏
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'pubcheck.refresh';
    this.statusBar.name = 'Pubspec 版本检查';
    this.statusBar.show();

    // 命令
    this.registerCommand('pubcheck.refresh', () => this.scheduleCheck(0));
    this.registerCommand('pubcheck.updatePackage', (name: unknown) => this.updatePackage(String(name ?? '')));
    this.registerCommand('pubcheck.openPackage', (name: unknown) => this.openPackage(String(name ?? '')));
    this.registerCommand('pubcheck.copyVersion', (name: unknown) => this.copyVersion(String(name ?? '')));

    // 事件：pubspec.yaml / pubspec.lock 的创建、修改、删除（FileSystemWatcher）
    const watcher = vscode.workspace.createFileSystemWatcher('**/pubspec.{yaml,yml,lock}');
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.onProjectFileChanged(uri)),
      watcher.onDidChange((uri) => this.onProjectFileChanged(uri)),
      watcher.onDidDelete((uri) => this.onProjectFileChanged(uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isProjectFile(doc.uri)) {
          this.scheduleCheck();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onEditorChanged(editor)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pubcheck')) {
          const nc = readConfig();
          this.enabled = vscode.workspace.getConfiguration('pubcheck').get<boolean>('enable', true);
          this.client = new PubDevClient(nc.cacheTtlSeconds * 1000, nc.concurrency);
          this.scheduleCheck(0);
        }
      })
    );

    this.scheduleCheck(500);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.diagnostics.dispose();
    this.decoOutdated.dispose();
    this.decoError.dispose();
    this.codeLensProvider.clear();
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.statusBar?.dispose();
  }

  // ---------- 检查流程 ----------

  private isProjectFile(uri: vscode.Uri): boolean {
    const base = path.basename(uri.fsPath).toLowerCase();
    return base === 'pubspec.yaml' || base === 'pubspec.yml' || base === 'pubspec.lock';
  }

  private onProjectFileChanged(uri: vscode.Uri): void {
    if (this.isProjectFile(uri)) {
      this.scheduleCheck();
    }
  }

  private scheduleCheck(delayMs = 800): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.runCheck(), delayMs);
  }

  private async runCheck(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.checking) {
      this.rerunRequested = true;
      return;
    }
    this.checking = true;
    try {
      if (this.pubspecUri) {
        this.setStatusBarLoading();
      }
      await this.doCheck();
    } finally {
      this.checking = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.scheduleCheck(0);
      }
    }
  }

  private async doCheck(): Promise<void> {
    const cfg = readConfig();
    const found = await vscode.workspace.findFiles('pubspec.yaml', undefined, 20);
    if (found.length === 0) {
      this.pubspecUri = undefined;
      this.statuses = [];
      this.diagnostics.clear();
      this.codeLensProvider.clear();
      this.treeProvider.setData([], '未找到 pubspec.yaml（请在 Flutter / Dart 项目根目录打开）');
      if (this.treeView) {
        this.treeView.message = this.treeProvider.getMessage();
      }
      this.setStatusBarText('$(search) 未找到 pubspec.yaml');
      return;
    }
    this.pubspecUri = found[0];

    const pubspecText = await this.readText(this.pubspecUri);
    const { deps } = parsePubspec(pubspecText);

    const lockUri = this.pubspecUri.with({
      path: this.pubspecUri.path.replace(/pubspec\.ya?ml$/i, 'pubspec.lock'),
    });
    const lockText = await this.readTextSafe(lockUri);
    const lock = lockText ? parseLockfile(lockText) : new Map();

    const excludes = new Set(cfg.excludes);
    const hostedNames = deps
      .filter((d) => d.kind === 'hosted' && !excludes.has(d.name))
      .map((d) => d.name);
    const latestMap = await this.client.fetchMany(hostedNames);

    this.statuses = analyze(deps, lock, latestMap, excludes);
    this.updateUi(cfg);
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  private async readTextSafe(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return await this.readText(uri);
    } catch {
      return undefined;
    }
  }

  private updateUi(cfg: UiOptions): void {
    // CodeLens
    if (cfg.enableCodeLens) {
      this.codeLensProvider.update(this.pubspecUri, this.statuses, cfg.showOnlyOutdated);
    } else {
      this.codeLensProvider.clear();
    }

    // 诊断
    if (cfg.enableDiagnostics && this.pubspecUri) {
      const diags: vscode.Diagnostic[] = [];
      for (const s of this.statuses) {
        if (s.state !== 'outdated' && s.state !== 'error') {
          continue;
        }
        const r = s.versionRange
          ? new vscode.Range(s.versionRange.line, s.versionRange.start, s.versionRange.line, s.versionRange.end)
          : new vscode.Range(s.lineRange.line, s.lineRange.start, s.lineRange.line, s.lineRange.end);
        diags.push(new vscode.Diagnostic(r, `[Pubspec 版本检查] ${s.name}: ${s.detail}`, vscode.DiagnosticSeverity.Warning));
      }
      this.diagnostics.set(this.pubspecUri, diags);
    } else {
      this.diagnostics.clear();
    }

    // 树视图
    const outdatedCount = this.statuses.filter((s) => s.state === 'outdated').length;
    const message =
      this.statuses.length === 0
        ? 'pubspec.yaml 中未发现托管依赖'
        : `共 ${this.statuses.length} 个依赖，${outdatedCount} 个可更新`;
    this.treeProvider.setData(this.statuses, message);
    if (this.treeView) {
      this.treeView.message = this.treeProvider.getMessage();
    }

    // 状态栏
    if (cfg.enableStatusBar) {
      this.setStatusBarText(this.buildStatusBarText());
    } else {
      this.statusBar?.hide();
    }

    // 装饰（当前活动编辑器）
    this.applyDecorations(vscode.window.activeTextEditor);
  }

  // ---------- UI ----------

  private setStatusBarLoading(): void {
    if (!this.statusBar) {
      return;
    }
    if (vscode.workspace.getConfiguration('pubcheck').get<boolean>('enableStatusBar', true)) {
      this.statusBar.text = '$(sync~spin) 正在检查依赖版本…';
      this.statusBar.tooltip = '正在向 pub.dev 查询最新版本';
      this.statusBar.show();
    }
  }

  private buildStatusBarText(): string {
    const outdated = this.statuses.filter((s) => s.state === 'outdated').length;
    const errors = this.statuses.filter((s) => s.state === 'error').length;
    if (outdated > 0) {
      return `$(arrow-up) ${outdated} 个依赖可更新`;
    }
    if (errors > 0) {
      return `$(warning) ${errors} 个依赖检查失败`;
    }
    return '$(check) 依赖已是最新';
  }

  private setStatusBarText(text: string): void {
    if (!this.statusBar) {
      return;
    }
    if (!vscode.workspace.getConfiguration('pubcheck').get<boolean>('enableStatusBar', true)) {
      return;
    }
    const outdated = this.statuses.filter((s) => s.state === 'outdated');
    this.statusBar.text = text;
    this.statusBar.tooltip =
      text === '$(search) 未找到 pubspec.yaml'
        ? '请在 Flutter / Dart 项目根目录打开工作区'
        : outdated.length > 0
          ? `可更新依赖：\n${outdated.map((s) => `• ${s.name}: ${s.currentDisplay} → ${s.latest}`).join('\n')}`
          : '所有依赖均已是最新版本';
    this.statusBar.show();
  }

  private provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.pubspecUri || document.uri.toString() !== this.pubspecUri.toString()) {
      return undefined;
    }
    const status = this.statuses.find(
      (s) =>
        position.line >= s.lineRange.line &&
        position.line <= s.lineRange.line + 1 &&
        position.character >= s.lineRange.start &&
        position.character <= s.lineRange.end
    );
    if (!status) {
      return undefined;
    }
    const md = new vscode.MarkdownString(
      [
        `**${status.name}**（${status.section}）`,
        '',
        `- 版本约束：\`${status.constraint || '—'}\``,
        `- 当前版本：\`${status.resolved ?? '未知'}\``,
        `- 最新版本：\`${status.latest ?? '—'}\``,
        status.prerelease ? `- 预发布：\`${status.prerelease}\`` : null,
        `- ${status.detail}`,
      ]
        .filter((x) => x !== null)
        .join('\n')
    );
    md.isTrusted = true;
    return new vscode.Hover(md, new vscode.Range(status.lineRange.line, status.lineRange.start, status.lineRange.line, status.lineRange.end));
  }

  private onEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (this.lastPubspecEditor && this.lastPubspecEditor !== editor) {
      this.lastPubspecEditor.setDecorations(this.decoOutdated, []);
      this.lastPubspecEditor.setDecorations(this.decoError, []);
    }
    this.lastPubspecEditor = editor;
    this.applyDecorations(editor);
  }

  private applyDecorations(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return;
    }
    if (!this.pubspecUri || editor.document.uri.toString() !== this.pubspecUri.toString()) {
      return;
    }
    if (!vscode.workspace.getConfiguration('pubcheck').get<boolean>('enableDecorations', true)) {
      editor.setDecorations(this.decoOutdated, []);
      editor.setDecorations(this.decoError, []);
      return;
    }
    const outdatedRanges: vscode.Range[] = [];
    const errorRanges: vscode.Range[] = [];
    for (const s of this.statuses) {
      if (!s.versionRange) {
        continue;
      }
      const range = new vscode.Range(s.versionRange.line, s.versionRange.start, s.versionRange.line, s.versionRange.end);
      if (s.state === 'outdated') {
        outdatedRanges.push(range);
      } else if (s.state === 'error') {
        errorRanges.push(range);
      }
    }
    editor.setDecorations(this.decoOutdated, outdatedRanges);
    editor.setDecorations(this.decoError, errorRanges);
  }

  // ---------- 命令 ----------

  private registerCommand(id: string, handler: (...args: unknown[]) => unknown): void {
    const disposable = vscode.commands.registerCommand(id, (...args: unknown[]) => handler(...args));
    this.subscriptions.push(disposable);
  }

  private getStatus(name: string): DependencyStatus | undefined {
    return this.statuses.find((s) => s.name === name);
  }

  private async openPackage(name: string): Promise<void> {
    const url = vscode.Uri.parse(`https://pub.dev/packages/${encodeURIComponent(name)}`);
    await vscode.env.openExternal(url);
  }

  private async copyVersion(name: string): Promise<void> {
    const status = this.getStatus(name);
    const version = status?.latest;
    if (!version) {
      vscode.window.showInformationMessage(`「${name}」暂无最新版本信息`);
      return;
    }
    await vscode.env.clipboard.writeText(version);
    vscode.window.showInformationMessage(`已复制 ${name} 的最新版本号 ${version}`);
  }

  private async updatePackage(name: string): Promise<void> {
    const status = this.getStatus(name);
    if (!status || status.state !== 'outdated' || !status.latest) {
      vscode.window.showInformationMessage(`「${name}」当前没有可更新的版本`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(versions) 更新约束为 ^${status.latest}`,
          description: `将 pubspec.yaml 中 ${name} 的版本约束替换为 ^${status.latest}`,
          action: 'update' as const,
        },
        {
          label: '$(copy) 复制最新版本号',
          description: `复制 ${status.latest}`,
          action: 'copy' as const,
        },
        {
          label: '$(link-external) 在 pub.dev 上查看',
          description: `https://pub.dev/packages/${name}`,
          action: 'open' as const,
        },
      ],
      {
        placeHolder: `「${name}」最新版本 ${status.latest}，当前 ${status.currentDisplay}，请选择操作`,
      }
    );
    if (!pick) {
      return;
    }
    if (pick.action === 'copy') {
      await this.copyVersion(name);
      return;
    }
    if (pick.action === 'open') {
      await this.openPackage(name);
      return;
    }
    // 更新约束
    if (!this.pubspecUri || !status.versionRange) {
      vscode.window.showWarningMessage('无法定位版本号位置，请重试');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.pubspecUri);
    const range = new vscode.Range(
      status.versionRange.line,
      status.versionRange.start,
      status.versionRange.line,
      status.versionRange.end
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.pubspecUri, range, `^${status.latest}`);
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(`已将 ${name} 更新为 ^${status.latest}，保存后建议运行 flutter pub get`);
    this.scheduleCheck(0);
  }
}
