import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  compareVersions,
  constraintAllows,
} from '../core/versioning';

test('parseVersion 解析完整版本号', () => {
  const v = parseVersion('1.2.3-dev.2+build5');
  assert.ok(v);
  assert.equal(v.major, 1);
  assert.equal(v.minor, 2);
  assert.equal(v.patch, 3);
  assert.deepEqual(v.pre, ['dev', '2']);
  assert.deepEqual(v.build, ['build5']);
});

test('parseVersion 忽略前导 v 与缺省段', () => {
  assert.deepEqual(parseVersion('v2.0'), { major: 2, minor: 0, patch: 0, pre: [], build: [] });
  assert.deepEqual(parseVersion('3'), { major: 3, minor: 0, patch: 0, pre: [], build: [] });
  assert.equal(parseVersion('not-a-version'), undefined);
});

test('compareVersions 稳定版本号大小', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.3') === 0);
});

test('compareVersions 预发布排序（稳定版 > 预发布）', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-alpha') > 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
  assert.ok(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.1') === 0);
});

test('compareVersions 忽略 build 元数据', () => {
  assert.ok(compareVersions('1.2.3+1', '1.2.3+2') === 0);
});

test('constraintAllows caret 约束', () => {
  assert.ok(constraintAllows('^1.2.3', '1.9.9'));
  assert.ok(!constraintAllows('^1.2.3', '2.0.0'));
  assert.ok(!constraintAllows('^1.2.3', '1.2.2'));
  assert.ok(constraintAllows('^0.2.3', '0.2.9'));
  assert.ok(!constraintAllows('^0.2.3', '0.3.0'));
  // pub caret 语义：^0.0.3 := >=0.0.3 <0.0.4，0.0.4 与 0.0.5 均不允许
  assert.ok(!constraintAllows('^0.0.3', '0.0.4'));
  assert.ok(!constraintAllows('^0.0.3', '0.0.5'));
  assert.ok(!constraintAllows('^0.0.3', '0.1.0'));
});

test('constraintAllows 区间与比较符', () => {
  assert.ok(constraintAllows('>=1.0.0 <2.0.0', '1.5.0'));
  assert.ok(!constraintAllows('>=1.0.0 <2.0.0', '2.0.0'));
  assert.ok(constraintAllows('>=0.18.0 <0.20.0', '0.19.0'));
  assert.ok(constraintAllows('>1.0.0', '1.0.1'));
  assert.ok(constraintAllows('<=2.0.0', '2.0.0'));
  assert.ok(!constraintAllows('<=2.0.0', '2.0.1'));
});

test('constraintAllows 精确版本 / any / 空', () => {
  assert.ok(constraintAllows('5.4.0', '5.4.0'));
  assert.ok(!constraintAllows('5.4.0', '5.4.1'));
  assert.ok(constraintAllows('any', '9.9.9'));
  assert.ok(constraintAllows('', '1.0.0'));
});

test('constraintAllows || 多组约束', () => {
  assert.ok(constraintAllows('^1.0.0 || ^2.0.0', '2.3.0'));
  assert.ok(!constraintAllows('^1.0.0 || ^3.0.0', '2.3.0'));
});

test('constraintAllows tilde', () => {
  assert.ok(constraintAllows('~1.2.0', '1.2.9'));
  assert.ok(!constraintAllows('~1.2.0', '1.3.0'));
});
