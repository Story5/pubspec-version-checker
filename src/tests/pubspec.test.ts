import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePubspec, parseLockfile } from '../core/pubspec';

const TESTDATA = path.resolve(__dirname, '..', '..', 'testdata');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(TESTDATA, name), 'utf8');
}

test('parsePubspec 解析出全部依赖及其类型', () => {
  const { deps } = parsePubspec(readFixture('pubspec.yaml'));
  const byName = new Map(deps.map((d) => [d.name, d]));

  assert.equal(deps.length, 10);

  assert.equal(byName.get('http')?.kind, 'hosted');
  assert.equal(byName.get('http')?.constraint, '^1.2.0');
  assert.equal(byName.get('http')?.section, 'dependencies');

  assert.equal(byName.get('dio')?.constraint, '5.4.0');
  assert.equal(byName.get('intl')?.constraint, '>=0.18.0 <0.20.0');

  // version 键形式的依赖
  assert.equal(byName.get('riverpod')?.kind, 'hosted');
  assert.equal(byName.get('riverpod')?.constraint, '^2.5.1');

  // 非托管依赖
  assert.equal(byName.get('flutter')?.kind, 'sdk');
  assert.equal(byName.get('my_private_pkg')?.kind, 'path');
  assert.equal(byName.get('git_pkg')?.kind, 'git');

  // dev_dependencies
  assert.equal(byName.get('flutter_lints')?.section, 'dev_dependencies');
  assert.equal(byName.get('flutter_test')?.kind, 'sdk');
});

test('parsePubspec 版本号位置精确（行 / 列）', () => {
  const { deps } = parsePubspec(readFixture('pubspec.yaml'));
  const http = deps.find((d) => d.name === 'http');
  assert.ok(http);
  // 第 12 行（0 起始为 11）：`  http: ^1.2.0`，版本从第 9 列起（8），结束 14
  assert.equal(http.lineRange.line, 11);
  assert.equal(http.versionRange?.line, 11);
  assert.equal(http.versionRange?.start, 8);
  assert.equal(http.versionRange?.end, 14);
  // lineRange 覆盖整行
  assert.equal(http.lineRange.start, 2);
  assert.equal(http.lineRange.end, 14);
});

test('parsePubspec 处理 dependency_overrides', () => {
  const text = `name: x
dependencies:
  http: ^1.2.0
dependency_overrides:
  http: ^1.2.1
`;
  const { deps } = parsePubspec(text);
  const overrides = deps.filter((d) => d.section === 'dependency_overrides');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].name, 'http');
  assert.equal(overrides[0].constraint, '^1.2.1');
});

test('parsePubspec 空 / 非法内容不抛异常', () => {
  assert.deepEqual(parsePubspec('').deps, []);
  assert.deepEqual(parsePubspec('not: [valid: yaml').deps, []);
  assert.deepEqual(parsePubspec('foo: bar').deps, []);
});

test('parseLockfile 解析解析版本与来源', () => {
  const lock = parseLockfile(readFixture('pubspec.lock'));
  assert.equal(lock.get('http')?.version, '1.2.0');
  assert.equal(lock.get('http')?.source, 'hosted');
  assert.equal(lock.get('provider')?.version, '6.1.2');
  assert.equal(lock.get('flutter')?.source, 'sdk');
  assert.equal(lock.get('flutter')?.version, '0.0.0');
  assert.equal(lock.size, 8);
});
