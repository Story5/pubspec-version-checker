import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePubspec, parseLockfile } from '../core/pubspec';
import { analyze } from '../core/analyzer';
import type { LatestInfo } from '../core/pubdev';

const TESTDATA = path.resolve(__dirname, '..', '..', 'testdata');

const deps = parsePubspec(fs.readFileSync(path.join(TESTDATA, 'pubspec.yaml'), 'utf8')).deps;
const lock = parseLockfile(fs.readFileSync(path.join(TESTDATA, 'pubspec.lock'), 'utf8'));

const LATEST: Record<string, LatestInfo> = {
  http: { version: '1.5.0' },
  provider: { version: '6.1.5' },
  dio: { version: '5.4.3' },
  intl: { version: '0.19.0' },
  riverpod: { version: '2.6.1' },
  flutter_lints: { version: '5.0.0' },
};

function latestMap(overrides: Record<string, LatestInfo | undefined> = {}): Map<string, LatestInfo | undefined> {
  const m = new Map<string, LatestInfo | undefined>();
  for (const [k, v] of Object.entries(LATEST)) {
    m.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    m.set(k, v);
  }
  return m;
}

test('analyze 有锁文件：以解析版本对比最新版本', () => {
  const statuses = analyze(deps, lock, latestMap(), new Set());
  const byName = new Map(statuses.map((s) => [s.name, s]));

  const http = byName.get('http');
  assert.equal(http?.state, 'outdated');
  assert.ok(http?.outdated);
  assert.equal(http?.currentDisplay, '1.2.0');
  assert.equal(http?.latest, '1.5.0');
  assert.equal(http?.detail, '当前 1.2.0，最新 1.5.0');

  // intl：锁文件 0.18.1 < 最新 0.19.0 → 过期（即使约束允许 0.19.0）
  assert.equal(byName.get('intl')?.state, 'outdated');
  assert.equal(byName.get('intl')?.currentDisplay, '0.18.1');

  // provider / dio / riverpod / flutter_lints 均过期
  for (const name of ['provider', 'dio', 'riverpod', 'flutter_lints']) {
    assert.equal(byName.get(name)?.state, 'outdated', `${name} 应过期`);
  }

  // 本地 / SDK / Git 依赖标记为 local，不报过期
  assert.equal(byName.get('flutter')?.state, 'local');
  assert.equal(byName.get('my_private_pkg')?.state, 'local');
  assert.equal(byName.get('git_pkg')?.state, 'local');
});

test('analyze 无锁文件：以约束是否允许最新版判断', () => {
  const statuses = analyze(deps, new Map(), latestMap(), new Set());
  const byName = new Map(statuses.map((s) => [s.name, s]));

  // ^1.2.0 允许 1.5.0（<2.0.0）→ 未过期，currentDisplay 显示约束
  assert.equal(byName.get('http')?.state, 'up-to-date');
  assert.equal(byName.get('http')?.currentDisplay, '^1.2.0');

  // >=0.18.0 <0.20.0 允许 0.19.0 → 未过期
  assert.equal(byName.get('intl')?.state, 'up-to-date');

  // 精确版本 5.4.0 不允许 5.4.3 → 过期
  assert.equal(byName.get('dio')?.state, 'outdated');
});

test('analyze 网络失败 / 包不存在 → error 状态', () => {
  const statuses = analyze(deps, lock, latestMap({ http: undefined }), new Set());
  const http = statuses.find((s) => s.name === 'http');
  assert.equal(http?.state, 'error');
  assert.ok(http?.detail.includes('无法'));
});

test('analyze 排除列表生效', () => {
  const statuses = analyze(deps, lock, latestMap(), new Set(['http', 'flutter']));
  assert.ok(!statuses.some((s) => s.name === 'http'));
  assert.ok(!statuses.some((s) => s.name === 'flutter'));
  assert.ok(statuses.some((s) => s.name === 'dio'));
});

test('analyze 预发布信息透传', () => {
  const statuses = analyze(deps, lock, latestMap({ http: { version: '1.5.0', prerelease: '2.0.0-beta.1' } }), new Set());
  const http = statuses.find((s) => s.name === 'http');
  assert.equal(http?.prerelease, '2.0.0-beta.1');
  assert.ok(http?.detail.includes('2.0.0-beta.1'));
});

test('analyze 已是最新：解析版本等于最新版', () => {
  const statuses = analyze(deps, lock, latestMap({ dio: { version: '5.4.0' } }), new Set());
  const dio = statuses.find((s) => s.name === 'dio');
  assert.equal(dio?.state, 'up-to-date');
  assert.ok(!dio?.outdated);
});
