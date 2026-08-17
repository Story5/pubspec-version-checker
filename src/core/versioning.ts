/**
 * 版本号解析与比较、pub 版本约束匹配（无任何 vscode 依赖，可独立测试）。
 *
 * 支持：
 * - semver 风格的版本号：major.minor.patch[-prerelease][+build]
 * - pub 版本约束：any、精确版本、^1.2.3（caret）、~1.2.3（tilde）、
 *   >= < > <= 组合区间，以及 || 分隔的多组约束。
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识，如 ['dev', '1']；空数组表示稳定版 */
  pre: string[];
  build: string[];
}

const VERSION_RE =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(raw: string): Version | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const s = raw.trim().replace(/^v/i, '');
  const m = VERSION_RE.exec(s);
  if (!m) {
    return undefined;
  }
  return {
    major: parseInt(m[1], 10),
    minor: m[2] !== undefined ? parseInt(m[2], 10) : 0,
    patch: m[3] !== undefined ? parseInt(m[3], 10) : 0,
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

function comparePre(a: string, b: string): number {
  // semver 规则：数字标识 < 字母标识；先比较标识长度再逐项比较
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const d = parseInt(a, 10) - parseInt(b, 10);
    return d < 0 ? -1 : d > 0 ? 1 : 0;
  }
  if (aNum) {
    return -1;
  }
  if (bNum) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersionObjects(a: Version, b: Version): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  // 无预发布 > 有预发布
  if (a.pre.length === 0 && b.pre.length === 0) {
    return 0;
  }
  if (a.pre.length === 0) {
    return 1;
  }
  if (b.pre.length === 0) {
    return -1;
  }
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const c = comparePre(x, y);
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

/** 比较两个版本字符串；无法解析时按相等处理，避免误报。 */
export function compareVersions(aRaw: string, bRaw: string): number {
  const a = parseVersion(aRaw);
  const b = parseVersion(bRaw);
  if (!a || !b) {
    return 0;
  }
  return compareVersionObjects(a, b);
}

/** pub 语义的 caret 上界：抬升第一个非零段。^1.2.3 → <2.0.0；^0.2.3 → <0.3.0；^0.0.3 → <0.0.4 */
function caretUpper(v: Version): Version {
  if (v.major > 0) {
    return { major: v.major + 1, minor: 0, patch: 0, pre: [], build: [] };
  }
  if (v.minor > 0) {
    return { major: 0, minor: v.minor + 1, patch: 0, pre: [], build: [] };
  }
  return { major: 0, minor: 0, patch: v.patch + 1, pre: [], build: [] };
}

function compareToOp(v: Version, targetRaw: string, op: string): boolean {
  const t = parseVersion(targetRaw);
  if (!t) {
    return true; // 无法解析的目标版本不拦截，避免误判
  }
  const c = compareVersionObjects(v, t);
  switch (op) {
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    default:
      return c === 0;
  }
}

function tokenAllows(tok: string, v: Version): boolean {
  if (tok.startsWith('^')) {
    const base = parseVersion(tok.slice(1));
    if (!base) {
      return true;
    }
    const upper = caretUpper(base);
    return compareVersionObjects(v, base) >= 0 && compareVersionObjects(v, upper) < 0;
  }
  if (tok.startsWith('~')) {
    const base = parseVersion(tok.slice(1));
    if (!base) {
      return true;
    }
    const upper: Version = { major: base.major, minor: base.minor + 1, patch: 0, pre: [], build: [] };
    return compareVersionObjects(v, base) >= 0 && compareVersionObjects(v, upper) < 0;
  }
  if (tok.startsWith('>=')) {
    return compareToOp(v, tok.slice(2), '>=');
  }
  if (tok.startsWith('<=')) {
    return compareToOp(v, tok.slice(2), '<=');
  }
  if (tok.startsWith('>')) {
    return compareToOp(v, tok.slice(1), '>');
  }
  if (tok.startsWith('<')) {
    return compareToOp(v, tok.slice(1), '<');
  }
  if (tok.startsWith('=')) {
    return compareToOp(v, tok.slice(1), '=');
  }
  // 裸版本号 → 精确匹配
  return compareToOp(v, tok, '=');
}

/**
 * 判断版本号 versionRaw 是否满足 pub 版本约束 constraint。
 * 例如 constraint 为 '^1.2.3'，version 为 '1.9.9' → true。
 */
export function constraintAllows(constraint: string, versionRaw: string): boolean {
  if (typeof constraint !== 'string' || typeof versionRaw !== 'string') {
    return false;
  }
  const v = parseVersion(versionRaw);
  if (!v) {
    return false;
  }
  const trimmed = constraint.trim();
  if (!trimmed || trimmed === 'any' || trimmed === '*') {
    return true;
  }
  const groups = trimmed.split(/\s*\|\|\s*/);
  for (const group of groups) {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return true;
    }
    if (tokens.every((t) => tokenAllows(t, v))) {
      return true;
    }
  }
  return false;
}
