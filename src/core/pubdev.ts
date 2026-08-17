/**
 * pub.dev API 客户端（无 vscode 依赖，可独立测试）。
 *
 * 调用 https://pub.dev/api/packages/<name> 获取最新版本信息：
 * - latest.version       → 最新稳定版
 * - latest.prerelease.version → 比稳定版更新的预发布版（可能不存在）
 *
 * 带内存缓存（正负结果分别设置 TTL）与并发限制，避免触发 pub.dev 限流。
 */
import * as https from 'https';

export interface LatestInfo {
  version?: string;
  prerelease?: string;
}

const USER_AGENT = 'pubspec-version-checker-vscode/0.1.0 (VS Code extension)';

interface CacheEntry {
  ts: number;
  ttlMs: number;
  info: LatestInfo | undefined;
}

function httpGetJson(url: string, timeoutMs: number, redirects: number): Promise<unknown> {
  return new Promise((resolve) => {
    if (redirects > 3) {
      resolve(undefined);
      return;
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          httpGetJson(next, timeoutMs, redirects + 1).then(resolve);
          return;
        }
        if (status === 404 || status === 429 || status >= 500) {
          res.resume();
          resolve(undefined);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve(undefined);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', () => resolve(undefined));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

function extractLatest(json: unknown): LatestInfo | undefined {
  if (!json || typeof json !== 'object') {
    return undefined;
  }
  const latest = (json as { latest?: { version?: unknown; prerelease?: { version?: unknown } } }).latest;
  if (!latest) {
    return undefined;
  }
  const info: LatestInfo = {};
  if (typeof latest.version === 'string' && latest.version) {
    info.version = latest.version;
  }
  if (
    latest.prerelease &&
    typeof latest.prerelease === 'object' &&
    typeof (latest.prerelease as { version?: unknown }).version === 'string' &&
    (latest.prerelease as { version?: string }).version
  ) {
    info.prerelease = (latest.prerelease as { version: string }).version;
  }
  return info.version || info.prerelease ? info : undefined;
}

export class PubDevClient {
  private cache = new Map<string, CacheEntry>();
  private negativeTtlMs = 5 * 60 * 1000;

  constructor(
    private ttlMs = 60 * 60 * 1000,
    private concurrency = 5,
    private timeoutMs = 15000
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  async fetch(pkg: string): Promise<LatestInfo | undefined> {
    const hit = this.cache.get(pkg);
    if (hit && Date.now() - hit.ts < hit.ttlMs) {
      return hit.info;
    }
    const json = await httpGetJson(
      `https://pub.dev/api/packages/${encodeURIComponent(pkg)}`,
      this.timeoutMs,
      0
    );
    const info = extractLatest(json);
    this.cache.set(pkg, {
      ts: Date.now(),
      ttlMs: info ? this.ttlMs : this.negativeTtlMs,
      info,
    });
    return info;
  }

  /** 带并发限制地批量查询；失败的包返回 undefined（不抛出）。 */
  async fetchMany(pkgs: string[]): Promise<Map<string, LatestInfo | undefined>> {
    const result = new Map<string, LatestInfo | undefined>();
    const unique = [...new Set(pkgs.filter((p) => p && p.length > 0))];
    if (unique.length === 0) {
      return result;
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        const pkg = unique[cursor++];
        result.set(pkg, await this.fetch(pkg));
      }
    };
    const workers = Math.max(1, Math.min(this.concurrency, unique.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return result;
  }
}
