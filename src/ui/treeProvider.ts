/**
 * 活动栏树视图：按「可更新 / 已是最新 / 其他」分组展示所有依赖及其版本状态。
 * 点击托管依赖可跳转 pub.dev。
 */
import * as vscode from 'vscode';
import type { DependencyStatus } from '../core/analyzer';

type GroupKey = 'outdated' | 'uptodate' | 'other';

interface GroupDef {
  key: GroupKey;
  label: string;
  icon: string;
  color: string;
}

const GROUPS: GroupDef[] = [
  { key: 'outdated', label: '可更新', icon: 'arrow-up', color: 'charts.yellow' },
  { key: 'uptodate', label: '已是最新', icon: 'check', color: 'charts.green' },
  { key: 'other', label: '其他', icon: 'circle-large-outline', color: 'charts.gray' },
];

class GroupNode extends vscode.TreeItem {
  constructor(readonly def: GroupDef, count: number) {
    super(`${def.label}（${count}）`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(def.icon, new vscode.ThemeColor(def.color));
  }
}

class DepNode extends vscode.TreeItem {
  constructor(readonly status: DependencyStatus) {
    super(status.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pubcheckDep';

    if (status.state === 'outdated') {
      this.description = `当前 ${status.currentDisplay} → 最新 ${status.latest}`;
      this.iconPath = new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow'));
      this.command = {
        command: 'pubcheck.updatePackage',
        title: '更新版本',
        arguments: [status.name],
      };
    } else if (status.state === 'up-to-date') {
      this.description = `✓ 已是最新 ${status.currentDisplay}`;
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      this.command = {
        command: 'pubcheck.openPackage',
        title: '在 pub.dev 打开',
        arguments: [status.name],
      };
    } else if (status.state === 'error') {
      this.description = '无法获取版本信息';
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    } else {
      this.description = '本地 / Git / SDK 依赖';
      this.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.gray'));
    }

    this.tooltip = new vscode.MarkdownString(
      [
        `**${status.name}**（${status.section}）`,
        '',
        `- 版本约束：\`${status.constraint || '—'}\``,
        `- 当前版本：\`${status.resolved ?? '未知'}\``,
        `- 最新版本：\`${status.latest ?? '—'}\``,
        status.prerelease ? `- 预发布：\`${status.prerelease}\`` : null,
        `- 状态：${status.detail}`,
      ]
        .filter((x) => x !== null)
        .join('\n')
    );
    this.tooltip.isTrusted = false;
  }
}

export class DependenciesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private statuses: DependencyStatus[] = [];
  private message = '';

  setData(statuses: DependencyStatus[], message: string): void {
    this.statuses = statuses;
    this.message = message;
    this.emitter.fire(undefined);
  }

  getMessage(): string {
    return this.message;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      const groups = GROUPS.map((def) => ({
        def,
        items: this.statuses.filter((s) => this.matchGroup(s, def.key)),
      })).filter((g) => g.items.length > 0);
      return groups.map((g) => new GroupNode(g.def, g.items.length));
    }
    const groupNode = element as GroupNode;
    return this.statuses
      .filter((s) => this.matchGroup(s, groupNode.def.key))
      .map((s) => new DepNode(s));
  }

  private matchGroup(s: DependencyStatus, key: GroupKey): boolean {
    switch (key) {
      case 'outdated':
        return s.state === 'outdated';
      case 'uptodate':
        return s.state === 'up-to-date';
      default:
        return s.state !== 'outdated' && s.state !== 'up-to-date';
    }
  }
}
