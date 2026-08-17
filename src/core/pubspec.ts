/**
 * 解析 pubspec.yaml 与 pubspec.lock（无 vscode 依赖，可独立测试）。
 *
 * 使用 `yaml` 包的 AST（parseDocument）以获取每个依赖及其版本号在源文件中的
 * 精确行列位置，供 CodeLens、装饰高亮、诊断和“更新约束”编辑使用。
 */
import {
  parseDocument,
  isMap,
  isScalar,
  isPair,
  type YAMLMap,
  type Pair,
  type Scalar,
} from 'yaml';

/** 文本范围（0 起始的行 / 列） */
export interface TextRange {
  line: number;
  start: number;
  end: number;
}

export type DepKind = 'hosted' | 'sdk' | 'git' | 'path' | 'unknown';
export type DepSection = 'dependencies' | 'dev_dependencies' | 'dependency_overrides';

export interface Dependency {
  name: string;
  kind: DepKind;
  /** 原始版本约束字符串（如 ^1.2.3），git/path/sdk 依赖为空串 */
  constraint: string;
  section: DepSection;
  /** 整行（name: value）范围，用于 CodeLens / hover */
  lineRange: TextRange;
  /** 版本号标量范围，用于装饰与编辑；git/path/sdk 依赖为 undefined */
  versionRange?: TextRange;
}

export interface PubspecInfo {
  deps: Dependency[];
}

export interface LockEntry {
  version: string;
  source: string;
}

function makeLineIndex(text: string): {
  /** 把绝对偏移转成 (line, 行内列) 范围 */
  toRange: (start: number, end: number) => TextRange;
  /** 各行长度（不含换行符），用于把范围扩展为整行 */
  lineLengths: number[];
} {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lineStarts.push(i + 1);
    }
  }
  const lineLengths: number[] = lineStarts.map((s, i) => {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : text.length;
    // 去掉行尾 \r
    return end > s && text.charCodeAt(end - 1) === 13 ? end - 1 - s : end - s;
  });
  const toRange = (start: number, end: number): TextRange => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= start) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const lineStart = lineStarts[lo];
    return { line: lo, start: start - lineStart, end: end - lineStart };
  };
  return { toRange, lineLengths };
}

function nodeRange(node: unknown): [number, number] | undefined {
  // Pair 类型声明中没有 range 属性，但运行时存在（yaml 包），这里用鸭子类型取
  const r = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
  if (r && r.length >= 2) {
    return [r[0], r[1]];
  }
  return undefined;
}

const SECTIONS: DepSection[] = ['dependencies', 'dev_dependencies', 'dependency_overrides'];

export function parsePubspec(text: string): PubspecInfo {
  const doc = parseDocument(text);
  const deps: Dependency[] = [];
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return { deps };
  }
  const { toRange, lineLengths } = makeLineIndex(text);
  const root = doc.contents as YAMLMap;

  for (const item of root.items) {
    if (!isPair(item) || !isScalar(item.key)) {
      continue;
    }
    const section = String(item.key.value);
    if (!SECTIONS.includes(section as DepSection) || !isMap(item.value)) {
      continue;
    }
    const depsMap = item.value as YAMLMap;
    for (const depItem of depsMap.items) {
      if (!isPair(depItem) || !isScalar(depItem.key)) {
        continue;
      }
      const name = String(depItem.key.value);
      const keyRange = nodeRange(depItem.key as Scalar);
      const pairRange = nodeRange(depItem);
      const lineRange = toRange(...(pairRange ?? keyRange ?? [0, 0]));
      // yaml 的 Pair range 只覆盖 key，把结束位置扩展到行尾（CodeLens / hover 按行定位）
      const lineLen = lineLengths[lineRange.line] ?? 0;
      lineRange.end = lineLen;

      let kind: DepKind = 'unknown';
      let constraint = '';
      let versionRange: TextRange | undefined;

      const valueNode = depItem.value;
      if (isScalar(valueNode)) {
        kind = 'hosted';
        constraint = String(valueNode.value);
        const r = nodeRange(valueNode);
        if (r) {
          versionRange = toRange(r[0], r[1]);
        }
      } else if (isMap(valueNode)) {
        const ver = valueNode.get('version', true);
        if (ver && isScalar(ver)) {
          kind = 'hosted';
          constraint = String(ver.value);
          const r = nodeRange(ver);
          if (r) {
            versionRange = toRange(r[0], r[1]);
          }
        } else if (valueNode.has('sdk')) {
          kind = 'sdk';
        } else if (valueNode.has('git')) {
          kind = 'git';
        } else if (valueNode.has('path')) {
          kind = 'path';
        }
      }

      deps.push({
        name,
        kind,
        constraint,
        section: section as DepSection,
        lineRange,
        versionRange,
      });
    }
  }
  return { deps };
}

export function parseLockfile(text: string): Map<string, LockEntry> {
  const result = new Map<string, LockEntry>();
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return result;
  }
  const packages = doc.contents.get('packages');
  if (!isMap(packages)) {
    return result;
  }
  for (const item of (packages as YAMLMap).items) {
    if (!isPair(item) || !isScalar(item.key)) {
      continue;
    }
    const name = String(item.key.value);
    const val = item.value;
    if (!isMap(val)) {
      continue;
    }
    // keepScalar=true 返回 Scalar 节点（get() 默认返回解析后的 JS 值，isScalar 无法识别）
    const ver = val.get('version', true);
    const src = val.get('source', true);
    result.set(name, {
      version: isScalar(ver) ? String(ver.value) : '',
      source: isScalar(src) ? String(src.value) : '',
    });
  }
  return result;
}

/** 供类型推断导出（避免 Pair/Scalar 未使用告警时保留类型） */
export type { Pair, Scalar };
