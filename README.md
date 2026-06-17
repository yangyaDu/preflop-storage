# Preflop Storage

Preflop Storage 是一个基于 **Bun + TypeScript + Rust (`napi-rs`)** 的德州扑克翻前策略存储项目。它的目标是把旧版 SQLite 行式数据转换成更适合查询和部署的二进制格式。

当前主线路径是 **Scheme2 + Rust**：

- `meta.db` 保存元数据和 action schema
- `.idx` 保存维度级索引
- `.bin` 保存真实策略矩阵
- Rust 原生插件负责热路径查询

如果你是第一次进入这个仓库，建议先看这三个入口：

- `src/scheme2/importer/build-binary-store.ts`：Scheme2 构建主流程
- `src/scheme2/query/query-service.ts`：Scheme2 查询服务
- `native-addon/src/lib.rs`：Rust 原生插件入口

## 文件和目录主要功能

### 顶层目录

| 路径 | 作用 |
| --- | --- |
| `src/` | TypeScript 主代码 |
| `native-addon/` | Rust `napi-rs` 原生插件，负责 Scheme2 热路径 |
| `tests/` | Bun 测试用例 |
| `docs/` | 进度、SDK、部署、精度等文档 |
| `reports/` | 分析、校验、benchmark 产出 |
| `range-db/` | 本地 SQLite 源数据和构建后的输出目录 |
| `package.json` | Bun scripts 入口 |

### `src/` 里的主要模块

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 对外导出公共 API |
| `src/binary/` | 通用二进制格式、header、CRC、pack 编解码 |
| `src/hand/hand-dict.ts` | 固定 169 手牌字典 |
| `src/cli/args.ts` | CLI 参数解析工具 |
| `src/utils/` | 维度解析、数学工具等通用逻辑 |
| `src/scheme1/` | 旧方案：SQLite 索引 + `.bin` |
| `src/scheme2/` | 当前主方案：`.idx + .bin + Rust` |

### Scheme2 相关关键文件

| 文件 | 作用 |
| --- | --- |
| `src/scheme2/cli/build-binary.ts` | Scheme2 构建 CLI 入口 |
| `src/scheme2/importer/build-binary-store.ts` | Scheme2 构建、manifest、resume、stats 核心实现 |
| `src/scheme2/db/schema.ts` | 轻量 `meta.db` 结构初始化 |
| `src/scheme2/db/naming.ts` | `.idx` 文件命名规则 |
| `src/scheme2/idx/idx-types.ts` | `.idx` 头和记录结构 |
| `src/scheme2/idx/idx-writer.ts` | `.idx` 写入逻辑 |
| `src/scheme2/idx/idx-reader.ts` | `.idx` 读取与二分查找 |
| `src/scheme2/query/query-service.ts` | 推荐查询 SDK |
| `src/scheme2/benchmark/runner.ts` | Scheme2 benchmark 运行器 |

### Scheme1 相关关键文件

| 文件 | 作用 |
| --- | --- |
| `src/scheme1/cli/build-binary.ts` | Scheme1 构建 CLI |
| `src/scheme1/importer/build-binary-store.ts` | Scheme1 构建核心实现 |
| `src/scheme1/query/preflop-query-service.ts` | Scheme1 查询服务 |
| `src/scheme1/cli/verify-binary.ts` | 旧 SQLite 和 Scheme1 二进制一致性校验 |
| `src/scheme1/cli/analyze-sqlite.ts` | 旧 SQLite 结构与体积分析 |
| `src/scheme1/cli/analyze-binary.ts` | 二进制输出分析 |

### Rust 原生插件关键文件

| 文件 | 作用 |
| --- | --- |
| `native-addon/src/lib.rs` | `DimensionHandle` 导出入口 |
| `native-addon/src/idx_reader.rs` | `.idx` mmap + 二分查找 |
| `native-addon/src/bin_reader.rs` | `.bin` mmap 读取 |
| `native-addon/src/pack_codec.rs` | range pack 热路径解码 |
| `native-addon/src/types.rs` | Rust 侧数据结构 |
| `native-addon/index.js` | Node/Bun 侧原生模块装载入口 |
| `native-addon/index.d.ts` | TypeScript 类型声明 |

## 安装和启动

这个项目不是 Web 服务，没有 `dev server`。通常的使用方式是：

1. 安装 Bun 依赖
2. 编译 Rust 原生插件
3. 运行构建、查询、校验或 benchmark 脚本

### 环境要求

- Bun 1.3 或更高版本
- Rust stable 工具链
- Windows 下建议安装 Visual Studio C++ Build Tools

可先确认环境：

```powershell
bun --version
rustc --version
cargo --version
```

### 1. 安装 Bun 依赖

```powershell
bun install
```

### 2. 构建 Rust 原生插件

进入 `native-addon/`：

```powershell
cd native-addon
```

先跑 Rust 测试：

```powershell
cargo test
```

再构建 `napi-rs` 模块：

```powershell
bunx @napi-rs/cli build --platform --release
```

Windows 如果需要显式指定目标三元组，可以用：

```powershell
bunx @napi-rs/cli build --platform --release --target x86_64-pc-windows-msvc
```

构建完成后回到项目根目录：

```powershell
cd ..
```

### 3. 运行基础检查

```powershell
bun run check
```

### 4. 快速体验一遍主流程

先构建 Scheme2：

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --overwrite
```

再查询一手牌：

```powershell
bun run query:scheme2 --dir range-db/binary-scheme2 --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
```

## 主要脚本说明和使用方法

下面按“日常最常用”的顺序来介绍。

### 1. 质量检查

| 命令 | 作用 |
| --- | --- |
| `bun test` | 运行 Bun 测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run lint` | ESLint 静态检查 |
| `bun run check` | 一次执行 typecheck + lint + test |

推荐在改动构建、查询、Rust 热路径后至少跑一次：

```powershell
bun run check
```

### 2. Scheme2 构建脚本

当前主构建脚本：

```powershell
bun run build:scheme2
```

它对应的实际入口是：

```text
src/scheme2/cli/build-binary.ts
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--source` | 旧 SQLite 源库路径，默认 `range-db/range.db` |
| `--out` | 输出目录，默认 `range-db/binary-scheme2` |
| `--overwrite` | 从头覆盖构建 |
| `--resume` | 读取 `manifest.json`，跳过已完成维度，重建失败维度 |
| `--dimension` | 只构建指定维度，可重复传入 |
| `--max-packs` | 限制每个维度最多构建多少个 pack，适合 smoke test |
| `--stats` | 输出 JSON 构建统计 |
| `--stats-md` | 输出 Markdown 构建统计 |

#### 全量重建

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --overwrite
```

#### 中断后续跑

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --resume
```

#### 只构建一个维度

```powershell
bun run build:scheme2 --dimension default:6:100 --overwrite
```

`--dimension` 支持两种写法：

```text
default:6:100
default_6max_100BB
```

#### 输出构建报告

```powershell
bun run build:scheme2 `
  --source range-db/range.db `
  --out range-db/binary-scheme2 `
  --overwrite `
  --stats reports/build-scheme2.json `
  --stats-md reports/build-scheme2.md
```

### 3. Scheme2 查询脚本

当前主查询脚本：

```powershell
bun run query:scheme2
```

对应入口：

```text
src/scheme2/cli/query-hand.ts
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--dir` | Scheme2 输出目录，默认 `range-db/binary-scheme2` |
| `--meta` | meta.db 路径，默认 `${dir}/meta.db` |
| `--strategy` | 策略名，默认 `default` |
| `--player-count` | 玩家数，必填 |
| `--depth-bb` | 筹码深度，必填 |
| `--concrete-line-id` | 具体行动线 ID，必填 |
| `--hand` | 手牌，如 `AA`、`AKs`、`22`，必填 |
| `--verify-checksum` | 查询时校验 CRC32C |

#### 示例

```powershell
bun run query:scheme2 `
  --dir range-db/binary-scheme2 `
  --player-count 6 `
  --depth-bb 100 `
  --concrete-line-id 1 `
  --hand AA
```

### 4. Scheme1 构建和查询脚本

这套脚本还保留着，主要用于：

- 和旧链路对照
- 运行已有校验脚本
- 做兼容性测试

#### 构建

```powershell
bun run build:binary --source range-db/range.db --out range-db/binary --overwrite
```

#### 查询

```powershell
bun run query:hand --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
```

### 5. 分析脚本

#### 分析旧 SQLite

```powershell
bun run analyze:sqlite --source range-db/range.db --out reports/sqlite-analysis.json --md reports/sqlite-analysis.md
```

输出内容包括：

- 库文件大小
- 表数量、索引数量
- 各 `range_data_*` 表的行数和分布
- 重复字符串和字段载荷的粗略估算

#### 分析二进制输出

```powershell
bun run analyze:binary --dir range-db/binary --sqlite-report reports/sqlite-analysis.json --out reports/binary-analysis.json --md reports/storage-analysis.md
```

输出内容包括：

- `meta.db` 大小
- `ranges_*.bin` 大小
- pack 数、平均 pack 大小
- action schema 复用情况
- 新旧体积对比

#### 一键分析

```powershell
bun run analyze
```

### 6. 校验脚本

当前校验脚本是：

```powershell
bun run verify:binary
```

对应入口：

```text
src/scheme1/cli/verify-binary.ts
```

注意：这条脚本当前主要用于 **Scheme1 二进制目录**，因为它依赖 `range_pack_index_*` 表做索引对照。

#### 抽样校验

```powershell
bun run verify:binary `
  --source range-db/range.db `
  --dir range-db/binary `
  --mode sample `
  --sample-size 10000 `
  --out reports/verify-sample.json `
  --md reports/verify-sample.md
```

#### 全量校验

```powershell
bun run verify:binary `
  --source range-db/range.db `
  --dir range-db/binary `
  --mode full `
  --out reports/verify-full.json `
  --md reports/verify-full.md
```

### 7. Benchmark 脚本

#### SQLite 基线

```powershell
bun run benchmark:sqlite
```

#### Scheme1 二进制

```powershell
bun run benchmark:binary
```

#### Scheme2 主线路径

```powershell
bun run benchmark:scheme2
```

推荐的 Scheme2 示例：

```powershell
bun run benchmark:scheme2 `
  --dir range-db/binary-scheme2 `
  --iterations 1000 `
  --batch-iterations 200 `
  --batch-size 20 `
  --warmup-iterations 20
```

额外常用参数：

| 参数 | 说明 |
| --- | --- |
| `--dimension` | 只测指定维度 |
| `--seed` | workload 随机种子 |
| `--verify-checksum` | 查询时校验 CRC |
| `--verify-results` | 抽样比对查询结果 |
| `--prewarm-action-schemas` | 预热 action schema |
| `--workload-mode` | workload 模式 |

#### 对比报告

如果要比较 SQLite 和 Scheme2，可以显式指定报告路径：

```powershell
bun run benchmark:compare `
  --sqlite reports/benchmark-sqlite.json `
  --binary reports/benchmark-scheme2.json `
  --out reports/benchmark-report.json `
  --md reports/benchmark-report.md
```

注意：`package.json` 里的 `bun run benchmark` 聚合脚本目前仍走的是 SQLite + Scheme1 + compare 这条历史链路，不包含 `benchmark:scheme2`。

## 输出目录和产物说明

### Scheme2 输出目录

```text
range-db/binary-scheme2/
  manifest.json
  meta.db
  ranges_default_6max_100BB.idx
  ranges_default_6max_100BB.bin
  ...
```

其中：

- `manifest.json`：记录构建时间、源库 checksum、维度状态、产物文件
- `meta.db`：保存 drill 场景、concrete line、action schema
- `.idx`：维度索引
- `.bin`：策略矩阵数据

### Scheme1 输出目录

```text
range-db/binary/
  meta.db
  ranges_default_6max_100BB.bin
  ...
```

## 代码里怎么用

推荐直接使用 `Scheme2QueryService`：

```ts
import { Scheme2QueryService } from "./src/scheme2/query/query-service";

const service = new Scheme2QueryService("range-db/binary-scheme2/meta.db", "range-db/binary-scheme2", {
  verifyChecksums: false,
  maxOpenHandles: 3,
  prewarmActionSchemas: false,
});

service.prewarmDimension({ strategy: "default", playerCount: 6, depthBb: 100 });

const result = service.getHandStrategySync({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "AA",
});

service.close();
```

更完整的 SDK 说明见 `docs/query-sdk.md`。

## 相关文档

| 文档 | 说明 |
| --- | --- |
| `docs/requirements-status-and-plan.md` | 当前进度和状态 |
| `docs/query-sdk.md` | 查询 SDK 说明 |
| `docs/deploy-and-rollback.md` | 部署、发布和回滚 |
| `docs/float32-precision-spec.md` | 精度与误差标准 |
| `docs/error-handling-strategy.md` | 错误处理策略 |
| `reports/` | 分析、校验、benchmark 报告 |
