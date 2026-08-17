/**
 * CodeLens 提供器：在每个依赖行上方显示版本对比提示。
 * - 有新版：↗ 有新版 x.y.z（当前 a.b.c）→ 点击可选择更新约束
 * - 已最新：✓ 已是最新 x.y.z（可通过设置关闭）
 * - 获取失败：! 无法获取版本信息
 */
import * as vscode from 'vscode';
import type { DependencyStatus } from '../core/analyzer';

export class VersionCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  private uri: vscode.Uri | undefined;
  private statuses: DependencyStatus[] = [];
  private showOnlyOutdated = true;

  update(uri: vscode.Uri | undefined, statuses: DependencyStatus[], showOnlyOutdated: boolean): void {
    this.uri = uri;
    this.statuses = statuses;
    this.showOnlyOutdated = showOnlyOutdated;
    this.emitter.fire();
  }

  clear(): void {
    this.uri = undefined;
    this.statuses = [];
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.uri || document.uri.toString() !== this.uri.toString()) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const s of this.statuses) {
      if (s.kind !== 'hosted') {
        continue; // 本地 / Git / SDK 依赖不显示
      }
      let title: string | undefined;
      if (s.state === 'outdated' && s.latest) {
        title = `↗ 有新版 ${s.latest}（当前 ${s.currentDisplay}）`;
      } else if (s.state === 'error') {
        title = '! 无法获取版本信息';
      } else if (!this.showOnlyOutdated) {
        title = `✓ 已是最新 ${s.currentDisplay}`;
      }
      if (!title) {
        continue;
      }
      const range = new vscode.Range(
        s.lineRange.line,
        s.lineRange.start,
        s.lineRange.line,
        s.lineRange.end
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          command: 'pubcheck.updatePackage',
          arguments: [s.name],
        })
      );
    }
    return lenses;
  }
}
