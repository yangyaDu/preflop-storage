# Preflop Storage

Preflop Storage 是一个基于 **Bun + TypeScript + Rust (`napi-rs`)** 的德州扑克翻前策略存储项目。它的目标是把旧版 SQLite 行式数据转换成更适合查询和部署的二进制格式。

当前主线路径是 **Range Strata Binary + Rust**：

- `meta.db` 保存元数据和 action schema
- `.idx` 保存维度级索引
- `.bin` 保存真实策略矩阵
- Rust 原生插件负责热路径查询

如果你是第一次进入这个仓库，建议先看这三个入口：

- `src/range-strata-binary/compiler/pipeline.ts`：Range Strata Binary 构建主流程
- `src/range-strata-binary/query/service.ts`：Range Strata Binary 查询服务
- `native-addon/src/lib.rs`：Rust 原生插件入口

## 文件和目录主要功能

### 顶层目录

| 路径 | 作用 |
| --- | --- |
| `src/` | TypeScript 主代码 |
| `native-addon/` | Rust `napi-rs` 原生插件，负责 Range Strata Binary 热路径 |
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
| `src/cli/args.ts` | CLI 参数解析工具（含 --help 支持） |
| `src/db/` | 共享命名规则、meta.db 查询（scheme1 和 range-strata-binary 共用） |
| `src/importer/` | 共享 SQLite 源库导入工具 |
| `src/precision/` | Float32 精度校验 |
| `src/benchmark/` | 共享 benchmark workload 生成与类型 |
| `src/analysis/` | 格式化工具（表格、字节、毫秒） |
| `src/query/errors.ts` | 错误类型定义 |
| `src/scheme1/` | 旧方案（对比基线）：SQLite 索引 + `.bin` |
| `src/range-strata-binary/` | 当前主方案：`.idx + .bin + Rust` |

### Range Strata Binary 相关关键文件

| 文件 | 作用 |
| --- | --- |
| `src/range-strata-binary/cli/compile.ts` | Range Strata Binary 构建 CLI 入口 |
| `src/range-strata-binary/compiler/pipeline.ts` | 构建编排：plan、resume、overwrite 决策 |
| `src/range-strata-binary/compiler/build-metadata.ts` | 从源库拷贝 drill/concrete 元数据到 meta.db |
| `src/range-strata-binary/compiler/build-report.ts` | 生成 manifest.json 与 JSON/Markdown 构建报告 |
| `src/range-strata-binary/compiler/build-statements.ts` | SQL prepared statement 管理与 finalize |
| `src/range-strata-binary/compiler/dimension-builder.ts` | 单维度构建（SQLite → .idx/.bin 流水线） |
| `src/range-strata-binary/compiler/manifest.ts` | manifest.json 读写与 schema 校验 |
| `src/range-strata-binary/compiler/plan.ts` | 构建计划解析 |
| `src/range-strata-binary/compiler/types.ts` | 编译器共享类型 |
| `src/range-strata-binary/compiler/cleanup.ts` | 输出目录清理 |
| `src/range-strata-binary/catalog/schema.ts` | 轻量 `meta.db` 结构初始化 |
| `src/range-strata-binary/catalog/naming.ts` | `.idx` 文件命名规则 |
| `src/range-strata-binary/index/types.ts` | `.idx` 头和记录结构 |
| `src/range-strata-binary/index/writer.ts` | `.idx` 写入逻辑 |
| `src/range-strata-binary/index/reader.ts` | `.idx` 读取与二分查找 |
| `src/range-strata-binary/query/service.ts` | 推荐查询 SDK（热路径入口） |
| `src/range-strata-binary/query/dimension-handle-pool.ts` | LRU mmap handle 池 |
| `src/range-strata-binary/query/action-schema-cache.ts` | Action schema LRU 缓存 |
| `src/range-strata-binary/query/action-filter.ts` | `getHandsByAction` 实现 |
| `src/range-strata-binary/query/flat-batch-result.ts` | Flat TypedArray 批量响应解析 |
| `src/range-strata-binary/query/types.ts` | 查询层类型定义 |
| `src/range-strata-binary/cli/cold-benchmark.ts` | 冷启动 benchmark 入口 |
| `src/range-strata-binary/cli/cold/` | 冷启动子模块（types、stats、report、cache-eviction） |

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

V1 构建流程以 Windows 本机为优先支持环境，`bun run build:native` 会自动选择当前平台 target。Windows x64 会固定使用 MSVC target，避免默认落到 GNU target 后出现 `libnode.dll not found`。

```powershell
bun run build:native
```

也可以显式指定平台：

```powershell
bun run build:native:win
bun run build:native:linux
bun run build:native:mac:arm64
bun run build:native:mac:x64
```

构建完成后再跑 native 检查：

```powershell
bun run check:native
```

更完整的平台矩阵和排错说明见 `docs/native-addon-build.md`。

### 3. 运行基础检查

```powershell
bun run check
```

发布前建议在 Range Strata Binary 输出目录已经生成后再跑更完整的检查：

```powershell
bun run check:release
```

### 4. 快速体验一遍主流程

先构建 Range Strata Binary：

```powershell
bun run build --source range-db/range.db --out range-db/range-strata-binary --overwrite
```

再查询一手牌：

```powershell
bun run query --dir range-db/range-strata-binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
```

## 主要脚本说明和使用方法

下面按“日常最常用”的顺序来介绍。

### 1. 质量检查

| 命令 | 作用 |
| --- | --- |
| `bun run build:native` | 按当前平台构建 Rust native addon；Windows x64 固定 MSVC target |
| `bun test` | 运行 Bun 测试 |
| `bun run fmt:native:check` | 运行 Rust formatter 检查 |
| `bun run test:native` | 运行 Rust 原生插件测试 |
| `bun run check:native` | 一次执行 Rust formatter 检查 + Rust 测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run lint` | ESLint 静态检查 |
| `bun run check` | 一次执行 typecheck + lint + test |
| `bun run check:release` | 发布前检查：`check` + `check:native` + Range Strata Binary standalone CRC 自检 |

推荐在改动构建、查询、Rust 热路径后至少跑一次：

```powershell
bun run check
```

### 2. Range Strata Binary 构建脚本

当前主构建脚本：

```powershell
bun run build
```

它对应的实际入口是：

```text
src/range-strata-binary/cli/compile.ts
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--source` | 旧 SQLite 源库路径，默认 `range-db/range.db` |
| `--out` | 输出目录，默认 `range-db/range-strata-binary` |
| `--overwrite` | 从头覆盖构建 |
| `--resume` | 读取 `manifest.json`，跳过已完成维度，重建失败维度 |
| `--dimension` | 只构建指定维度，可重复传入 |
| `--max-packs` | 限制每个维度最多构建多少个 pack，适合 smoke test |
| `--stats` | 输出 JSON 构建统计 |
| `--stats-md` | 输出 Markdown 构建统计 |

#### 全量重建

```powershell
bun run build --source range-db/range.db --out range-db/range-strata-binary --overwrite
```

#### 中断后续跑

```powershell
bun run build --source range-db/range.db --out range-db/range-strata-binary --resume
```

`--resume` 只适合同一个 source DB 的中断恢复。如果 SQLite 源库内容发生变化，命令会拒绝续跑；请改用 `--overwrite` 重新生成完整一致的数据版本。

#### 只构建一个维度

```powershell
bun run build --dimension default:6:100 --overwrite
```

`--dimension` 支持两种写法：

```text
default:6:100
default_6max_100BB
```

#### 输出构建报告

```powershell
bun run build `
  --source range-db/range.db `
  --out range-db/range-strata-binary `
  --overwrite `
  --stats reports/build-range-strata-binary.json `
  --stats-md reports/build-range-strata-binary.md
```

### 3. Range Strata Binary 查询脚本

当前主查询脚本：

```powershell
bun run query
```

对应入口：

```text
src/range-strata-binary/cli/query.ts
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--dir` | Range Strata Binary 输出目录，默认 `range-db/range-strata-binary` |
| `--meta` | meta.db 路径，默认 `${dir}/meta.db` |
| `--strategy` | 策略名，默认 `default` |
| `--player-count` | 玩家数，必填 |
| `--depth-bb` | 筹码深度，必填 |
| `--concrete-line-id` | 具体行动线 ID，必填 |
| `--hand` | 手牌，如 `AA`、`AKs`、`22`，必填 |
| `--verify-checksum` | 查询时校验 CRC32C |

#### 示例

```powershell
bun run query `
  --dir range-db/range-strata-binary `
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
bun run src/scheme1/cli/build-binary.ts --source range-db/range.db --out range-db/binary --overwrite
```

#### 查询

```powershell
bun run src/scheme1/cli/query.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
```

### 5. 分析脚本

#### 分析旧 SQLite

```powershell
bun run src/scheme1/cli/analyze-sqlite.ts --source range-db/range.db --out reports/sqlite-analysis.json --md reports/sqlite-analysis.md
```

输出内容包括：

- 库文件大小
- 表数量、索引数量
- 各 `range_data_*` 表的行数和分布
- 重复字符串和字段载荷的粗略估算

#### 分析二进制输出

```powershell
bun run src/scheme1/cli/analyze-binary.ts --dir range-db/binary --sqlite-report reports/sqlite-analysis.json --out reports/binary-analysis.json --md reports/storage-analysis.md
```

输出内容包括：

- `meta.db` 大小
- `ranges_*.bin` 大小
- pack 数、平均 pack 大小
- action schema 复用情况
- 新旧体积对比

#### 一键分析

```powershell
bun run src/scheme1/cli/analyze-sqlite.ts --source range-db/range.db --out reports/sqlite-analysis.json --md reports/sqlite-analysis.md
bun run src/scheme1/cli/analyze-binary.ts --dir range-db/binary --sqlite-report reports/sqlite-analysis.json --out reports/binary-analysis.json --md reports/storage-analysis.md
```

### 6. 校验脚本

#### Range Strata Binary 主线校验

当前主线校验脚本是：

```powershell
bun run verify
```

默认 `standalone` 模式不依赖 source DB，会检查 `manifest.json`、`meta.db`、`.idx`、`.bin` 的结构和交叉引用。

```powershell
bun run verify `
  --mode standalone `
  --dir range-db/range-strata-binary `
  --verify-checksum `
  --out reports/range-strata-verify-standalone.json `
  --md reports/range-strata-verify-standalone.md
```

需要和旧 SQLite 源库做数据交叉校验时使用 `cross` 模式：

```powershell
bun run verify `
  --mode cross `
  --source range-db/range.db `
  --dir range-db/range-strata-binary `
  --sample-size 10000 `
  --verify-checksum `
  --out reports/range-strata-verify-cross.json `
  --md reports/range-strata-verify-cross.md
```

如果要逐行全量交叉校验，把 `--sample-size` 设为 `0`。

#### Scheme1 旧校验

旧校验脚本是：

```powershell
bun run src/scheme1/cli/verify-binary.ts
```

对应入口：

```text
src/scheme1/cli/verify-binary.ts
```

注意：这条脚本当前主要用于 **Scheme1 二进制目录**，因为它依赖 `range_pack_index_*` 表做索引对照。

#### 抽样校验

```powershell
bun run src/scheme1/cli/verify-binary.ts `
  --source range-db/range.db `
  --dir range-db/binary `
  --mode sample `
  --sample-size 10000 `
  --out reports/verify-sample.json `
  --md reports/verify-sample.md
```

#### 全量校验

```powershell
bun run src/scheme1/cli/verify-binary.ts `
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
bun run src/scheme1/cli/benchmark-binary.ts
```

#### Range Strata Binary 主线路径

```powershell
bun run benchmark
```

推荐的 Range Strata Binary 示例：

```powershell
bun run benchmark `
  --dir range-db/range-strata-binary `
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

#### Range Strata Binary 冷启动

默认读取 `manifest.json` 中全部成功维度；当前生产产物应覆盖 9 个维度。

```powershell
bun run benchmark:cold `
  --source range-db/range.db `
  --dir range-db/range-strata-binary `
  --runs 10 `
  --concrete-line-id 1 `
  --hand AA `
  --mode process-cold
```

默认输出：

```text
reports/benchmark-cold-start.json
reports/benchmark-cold-start.md
```

#### 对比报告

如果要比较 SQLite 和 Range Strata Binary，可以显式指定报告路径：

```powershell
bun run benchmark:compare `
  --sqlite reports/benchmark-sqlite.json `
  --binary reports/benchmark-range-strata-binary.json `
  --out reports/benchmark-report.json `
  --md reports/benchmark-report.md
```

## 输出目录和产物说明

### Range Strata Binary 输出目录

```text
range-db/range-strata-binary/
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

推荐直接使用 `RangeStrataQueryService`：

```ts
import { RangeStrataQueryService } from "./src/range-strata-binary/query/service";

const service = new RangeStrataQueryService("range-db/range-strata-binary/meta.db", "range-db/range-strata-binary", {
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
| `docs/native-addon-build.md` | Rust native addon 多平台构建说明 |
| `docs/deploy-and-rollback.md` | 部署、发布和回滚 |
| `docs/float32-precision-spec.md` | 精度与误差标准 |
| `docs/error-handling-strategy.md` | 错误处理策略 |
| `reports/` | 分析、校验、benchmark 报告 |
