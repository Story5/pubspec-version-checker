# Pubspec 版本检查器（Pubspec Version Checker）

一个 VS Code 扩展：**自动检查 Flutter / Dart 项目 `pubspec.yaml` 中依赖（Package）与插件（Plugin）使用的版本，与 [pub.dev](https://pub.dev) 发布的最新版本对比，并通过多种可视化方式提醒开发者有新版本可用。**

## 功能特性

- 📋 **CodeLens 提示**：在每个依赖行上方显示最新版本，如 `↗ 有新版 1.5.0（当前 1.2.0）`，点击可直接更新
- 🖍️ **版本号高亮**：过期的版本号在编辑器中以黄色虚线 / 背景高亮
- ⚠️ **问题面板诊断**：过期的依赖在「问题」面板生成警告（支持跳转到 pubspec.yaml 对应行）
- 📊 **状态栏**：显示「N 个依赖可更新」，鼠标悬停查看明细，点击可重新检查
- 🌲 **活动栏树视图**：按「可更新 / 已是最新 / 其他」分组展示全部依赖，点击跳转 pub.dev
- 🔍 **Hover 详情**：鼠标悬停依赖行，展示约束 / 当前 / 最新 / 预发布版本
- ⚡ **一键更新**：选择「更新约束为 ^最新版本」，自动改写 `pubspec.yaml`
- 🧠 **智能判断**：优先读取 `pubspec.lock` 中的实际安装版本对比；无锁文件时判断最新版是否落在当前约束内
- ⏱️ **缓存与并发**：版本查询结果缓存 1 小时（可配置），并发请求防限流
- 🚫 **排除列表**：可跳过私有包 / 不想升级的包

## 工作原理

1. 解析工作区根目录的 `pubspec.yaml`（`dependencies` / `dev_dependencies` / `dependency_overrides`，含 `git:` / `path:` / `sdk:` 依赖的识别）
2. 读取 `pubspec.lock` 获取当前实际安装版本（仅 `hosted` 来源）
3. 调用 [pub.dev API](https://pub.dev/api/packages/<pkg>) 获取每个包的最新稳定版（含预发布信息）
4. 版本对比规则：优先「锁文件版本 vs 最新版」；无锁文件时按「最新版是否满足版本约束」判断
5. 通过 CodeLens / 装饰 / 诊断 / 状态栏 / 树视图 / Hover 六种渠道可视化呈现

## 安装

### 方式一：直接安装 vsix（推荐）

```bash
# 在项目目录下执行打包
npx @vscode/vsce package
# 生成 pubspec-version-checker-0.1.0.vsix
# VS Code 命令面板 → Extensions: Install from VSIX... 选择该文件
```

### 方式二：从源码调试运行

1. 克隆 / 打开本项目目录
2. `npm install`
3. 按 `F5`（选择「运行扩展（调试）」），会打开新的「扩展开发宿主」窗口
4. 在新窗口中打开任意 Flutter / Dart 项目，即可看到效果

## 使用说明

打开 Flutter / Dart 项目后，扩展会自动激活并检查：

| 视觉元素 | 说明 |
| --- | --- |
| 依赖行上方 CodeLens | `↗ 有新版 x.y.z（当前 a.b.c）`，点击弹出操作菜单 |
| 黄色高亮的版本号 | 该依赖有更新版本 |
| 状态栏 `⬆ N 个依赖可更新` | 点击触发重新检查 |
| 左侧活动栏「Pubspec 版本检查」 | 树视图分组展示所有依赖 |
| 问题面板警告 | `[Pubspec 版本检查] pkg: 当前 x，最新 y` |
| 悬停依赖行 | 显示约束 / 当前 / 最新版本详情 |

点击 CodeLens 或树视图中的「可更新」依赖，可快速选择：

- **更新约束为 `^最新版`**：自动改写 `pubspec.yaml`（建议保存后运行 `flutter pub get`）
- **复制最新版本号**：复制到剪贴板
- **在 pub.dev 上查看**：浏览器打开该包主页

## 配置项

在 `settings.json` 中配置：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `pubcheck.enable` | `true` | 总开关 |
| `pubcheck.showOnlyOutdated` | `true` | CodeLens 只显示「有新版」的依赖 |
| `pubcheck.enableCodeLens` | `true` | 启用 CodeLens |
| `pubcheck.enableDecorations` | `true` | 启用版本号高亮 |
| `pubcheck.enableDiagnostics` | `true` | 启用问题面板诊断 |
| `pubcheck.enableStatusBar` | `true` | 启用状态栏 |
| `pubcheck.excludePackages` | `[]` | 跳过检查的包名，如 `["my_private_pkg"]` |
| `pubcheck.cacheTtlSeconds` | `3600` | pub.dev 查询缓存时间（秒） |
| `pubcheck.concurrency` | `5` | 并发请求数 |

## 已知限制

- 当前检查**第一个工作区根目录**（多根工作区取首个含 `pubspec.yaml` 的目录）的 `pubspec.yaml`
- 私有仓库 / 内部 pub 源（非 pub.dev）的包无法查询，会标记为「无法获取版本信息」
- 升级约束为 `^最新版` 后请自行确认是否存在破坏性变更（major 版本升级）

## 项目结构

```
src/
├── extension.ts          # 扩展入口：事件、命令、UI 装配
├── core/
│   ├── versioning.ts     # 版本解析 / 比较 / pub 约束匹配（纯逻辑）
│   ├── pubspec.ts        # pubspec.yaml / pubspec.lock 解析（含行列定位）
│   ├── pubdev.ts         # pub.dev API 客户端（缓存 + 并发）
│   └── analyzer.ts       # 状态汇总分析（纯逻辑）
└── ui/
    ├── codeLensProvider.ts  # CodeLens 提供器
    └── treeProvider.ts      # 活动栏树视图
```

## 开发

```bash
npm install       # 安装依赖
npm run compile   # 编译到 out/
npm test          # 运行单元测试（node --test）
npm run watch     # 增量编译
npm run package   # 打包 vsix
```

## License

MIT
