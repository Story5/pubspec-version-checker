/**
 * 汇总分析：把「依赖定义 + 锁文件解析版本 + pub.dev 最新版本」合并为展示状态。
 * 纯函数，无 vscode 依赖，可独立测试。
 */
import { type Dependency, type LockEntry } from './pubspec';
import { compareVersions, constraintAllows } from './versioning';
import type { LatestInfo } from './pubdev';

export type DepState = 'up-to-date' | 'outdated' | 'error' | 'local';

export interface DependencyStatus extends Dependency {
  /** 锁文件中解析出的当前安装版本（仅 hosted 来源有效） */
  resolved?: string;
  latest?: string;
  /** 比最新稳定版更新的预发布版（若有） */
  prerelease?: string;
  state: DepState;
  outdated: boolean;
  /** 用于展示的“当前版本”：优先 resolved，否则约束串 */
  currentDisplay: string;
  detail: string;
}

export function analyze(
  deps: Dependency[],
  lock: Map<string, LockEntry>,
  latestMap: Map<string, LatestInfo | undefined>,
  excludes: Set<string>
): DependencyStatus[] {
  const out: DependencyStatus[] = [];

  for (const dep of deps) {
    if (excludes.has(dep.name)) {
      continue;
    }
    const status: DependencyStatus = {
      ...dep,
      state: 'local',
      outdated: false,
      currentDisplay: dep.constraint || '',
      detail: '',
    };

    // git / path / sdk 依赖不在 pub.dev 上，跳过版本对比
    if (dep.kind !== 'hosted') {
      status.detail = '本地 / Git / SDK 依赖，跳过版本检查';
      out.push(status);
      continue;
    }

    const lockEntry = lock.get(dep.name);
    // 仅 hosted 来源的锁版本才是“从 pub.dev 安装的版本”
    const resolved = lockEntry && lockEntry.source === 'hosted' ? lockEntry.version : undefined;

    const info = latestMap.get(dep.name);
    if (!info?.version) {
      status.state = 'error';
      status.detail = '无法从 pub.dev 获取版本信息（网络异常或包不存在）';
      out.push(status);
      continue;
    }
    status.latest = info.version;
    status.prerelease = info.prerelease;

    if (resolved) {
      status.resolved = resolved;
      status.currentDisplay = resolved;
      status.outdated = compareVersions(resolved, info.version) < 0;
    } else {
      // 无锁文件（未执行 pub get）时：最新版本是否落在当前约束内
      status.outdated = !constraintAllows(dep.constraint, info.version);
      status.currentDisplay = dep.constraint || 'any';
    }

    status.state = status.outdated ? 'outdated' : 'up-to-date';
    status.detail = status.outdated
      ? `当前 ${status.currentDisplay}，最新 ${info.version}` +
        (info.prerelease ? `（另有预发布 ${info.prerelease}）` : '')
      : `当前已是最新 ${info.version}`;
    out.push(status);
  }
  return out;
}
