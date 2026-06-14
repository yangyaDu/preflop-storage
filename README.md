# Preflop Storage

Preflop Storage 是一个基于 Bun + TypeScript + Rust (napi-rs) 的德州扑克翻前策略二进制存储项目。

项目目标是把旧 SQLite 中逐行保存的 range 策略数据，转换为：

- `meta.db`：保存场景、抽象行动线、具体行动线、action schema、二进制文件索引。
- `ranges_*.bin`：保存真实手牌策略矩阵，使用固定 Float32 little-endian 二进制格式。

查询热路径（.idx 二分查找 + pack 解码）使用 **Rust napi-rs 原生插件**，随机访问场景延迟与 SQLite 接近（0.27ms vs 0.06ms），但冷启动快 41%（10.7ms vs 18.1ms），存储节省 76%（344 MB vs 1,447 MB）。

### 性能概览（1000 随机手牌查询 + 200 批次查询，9 维度随机，warm OS cache）

| 方案 | 存储 | 单手牌查询 (avg) | 批量查询(20) (avg) | 冷启动 |
|---|---|---|---|---|
| SQLite 原版 | 1,447 MB | 0.058 ms | 1.096 ms | 18.1 ms |
| 方案一（SQLite索引+.bin） | 347 MB | 0.299 ms | 2.423 ms | 159.7 ms |
| **方案二 + Rust（当前）** | **344 MB** | **0.269 ms** | **2.476 ms** | **10.7 ms** |

> 以上为 OS 文件缓存预热后的稳态性能（代表性生产环境）。方案二在缓存全命中场景下（同 item 反复查询）可达 0.006 ms，此时远快于 SQLite。
> 详细对比见 `docs/requirements-status-and-plan.md` 第 12 节。

## 项目主题

旧数据结构是：

```text
Drill 场景 -> 抽象行动线 -> 具体行动线 -> 手牌策略数据
```

本项目转换后的结构是：

```text
SQLite meta.db (分表优化版):
  drill_scenario_lines_{strategy}
  concrete_lines_{strategy}_{playerCount}max_{depthBb}BB
  range_pack_index_{strategy}_{playerCount}max_{depthBb}BB
  action_schemas

Binary ranges_*.bin:
  hand_ids
  action_masks
  frequency / hand_ev Float32 matrix
```

### 数据库分表优化设计

为了最大化节省空间并提升查询效率，`meta.db` 中的 `concrete_lines` 和 `range_pack_index` 表已按 **维度（strategy + playerCount + depthBb）** 拆分为具体子表：

1. **`concrete_lines_{strategy}_{playerCount}max_{depthBb}BB`**:
   * 去除了冗余的 `player_count` 和 `depth_bb` 列（直接从表名推导）。
   * `concrete_line_id` 设为 `INTEGER PRIMARY KEY`，启用 SQLite 的 rowid 别名，消除了主键 B-Tree 的额外存储开销。
   * `UNIQUE` 约束从 4 列缩短到 2 列：`UNIQUE(abstract_line, concrete_line)`，索引树更加紧凑。

2. **`range_pack_index_{strategy}_{playerCount}max_{depthBb}BB`**:
   * 去除了冗余的 `player_count`、`depth_bb` 以及 `bin_file` 列（均由对应的表名和维度直接推导）。
   * `concrete_line_id` 同样作为 `INTEGER PRIMARY KEY` 以零额外开销存储。
   * 存储的列仅包含：`action_schema_id`、`hand_count`、`offset`、`byte_length`、`checksum`。

查询时先通过 `meta.db` 找到某个 `concrete_line_id` 对应的 `offset + byte_length`，再从 `ranges_*.bin` 中随机读取该 pack，解码成旧接口可使用的 action 策略结果。

## 目录架构

```text
preflop-storage/
  package.json
  tsconfig.json
  README.md

  native-addon/                 # Rust napi-rs 原生插件
    Cargo.toml
    src/
      lib.rs                    # DimensionHandle 导出
      idx_reader.rs             # mmap .idx + 二分查找
      bin_reader.rs             # mmap .bin 零拷贝读取
      pack_codec.rs             # 核心 pack 解码（热路径）
      crc32c.rs                 # 编译期 CRC32C 查找表
      types.rs                  # 二进制格式类型 + napi 对象
    index.js                    # 平台分发入口
    index.d.ts                  # TypeScript 类型声明

  range-db/
    range.db                    # 旧 SQLite 源数据（1.4 GB）
    binary/                     # 方案一生成目录（.bin 文件）
      meta.db
      ranges_default_*.bin
    binary-scheme2/             # 方案二生成目录（.idx + .bin 文件）
      meta.db
      ranges_default_*.idx
      ranges_default_*.bin

  src/
    binary/                     # 二进制格式、pack、header、CRC、reader/writer
    cli/                        # 命令行入口
    db/                         # meta.db 表结构与查询封装
    hand/                       # 169 手牌字典
    importer/                   # 旧 SQLite -> 二进制库构建器
    query/                      # 方案一查询服务 (PreflopQueryService)
    benchmark/                  # 通用 benchmark 基础设施
    scheme1/                    # 方案一：db / importer / query / benchmark
    scheme2/                    # 方案二：db / idx / query / benchmark
    index.ts                    # 模块统一导出

  tests/

  docs/
    requirements-status-and-plan.md   # 项目进度与四方案对比
    query-sdk.md                      # 查询 SDK 文档
    notes/                            # 架构调研与技术笔记

  reports/                     # 分析、校验、benchmark 报告

## 运行环境与依赖

需要安装：

- Bun 1.3 或更高版本
- Rust 工具链（仅构建 native-addon 时需要）：rustc + cargo

项目运行时依赖 Bun 内置能力：

- `bun:sqlite`：Bun 内置 SQLite
- `node:fs/promises`：文件随机读写
- `native-addon/`：Rust napi-rs 编译生成的 `.node` 二进制（提供 `DimensionHandle`）

开发阶段会安装以下 devDependencies：

- `typescript`：提供 `tsc --noEmit` 类型检查。
- `@types/bun`：提供 Bun 运行时类型，例如 `Bun.argv`、`bun:sqlite`、`bun:test`。
- `eslint`：代码静态检查。
- `@eslint/js`：ESLint 官方 JavaScript 推荐规则。
- `typescript-eslint`：让 ESLint 支持 TypeScript 语法和 TS 规则。

安装依赖命令：

```powershell
bun install
```

构建原生插件（仅在 native-addon 源码修改后需要）：

```powershell
cd native-addon && cargo test && napi build --release
```

确认 Bun 可用：

```powershell
bun --version
```

## 常用命令

### 质量检查

```powershell
bun test                    # 运行测试（22 个 TS 测试 + 17 个 Rust 测试）
bun run typecheck           # TypeScript 类型检查
bun run lint                # ESLint 静态检查
bun run check               # 一键：typecheck + lint + test
```

### 构建

```powershell
# 方案一构建（SQLite 索引 + .bin）
bun run build:binary --source range-db/range.db --out range-db/binary --overwrite

# 方案二构建（.idx 独立索引 + .bin + 精简 meta.db）
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --overwrite

# 构建单个维度小样本
bun run build:binary --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

### 查询

```powershell
# 方案一查询
bun run query:hand --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22

# 方案二查询（使用 .idx + Rust DimensionHandle）
bun run query:scheme2 --dir range-db/binary-scheme2 --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22

# 带 CRC 校验
bun run query:hand --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22 --verify-checksum
```

### 分析与校验

```powershell
bun run analyze          # 一键：SQLite 分析 + 二进制分析 + 体积对比
bun run verify:binary    # 抽样校验或全量校验
```

### Benchmark

```powershell
bun run benchmark:sqlite                            # SQLite 方案
bun run benchmark:binary                            # 方案一
bun run benchmark:scheme2                           # 方案二 + Rust
bun run benchmark:compare                           # 生成对比报告
bun run benchmark                                    # 一键：全部
```

## 构建配置

`build-binary.ts` 支持以下参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--source` | `range-db/range.db` | 旧 SQLite 源数据库路径 |
| `--out` | `range-db/binary` | 新二进制库输出目录 |
| `--overwrite` | false | 输出目录已有 `meta.db` 时是否覆盖 |
| `--dimension` | 全部维度 | 只构建指定维度，可重复传入 |
| `--max-packs` | 不限制 | 每个维度最多构建多少个 concrete line pack，主要用于 smoke test |

`--dimension` 支持两种写法：

```powershell
--dimension default:6:100
--dimension default_6max_100BB
```

当前旧库中会自动识别类似这些表：

```text
range_data_default_6max_100BB
range_data_default_6max_200BB
range_data_default_6max_300BB
range_data_default_8max_100BB
range_data_default_9max_300BB
```

## 查询配置

`query-hand.ts` 支持以下参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--dir` | `range-db/binary` | 二进制库目录 |
| `--meta` | `${dir}/meta.db` | meta SQLite 路径 |
| `--strategy` | `default` | 策略名 |
| `--player-count` | 必填 | 玩家数，例如 `6`、`8`、`9` |
| `--depth-bb` | 必填 | 筹码深度，例如 `100`、`200`、`300` |
| `--concrete-line-id` | 必填 | 具体行动线 ID |
| `--hand` | 必填 | 手牌代码，例如 `AA`、`AKs`、`22` |
| `--verify-checksum` | false | 读取 pack 时是否校验 CRC32C |

返回示例：

```json
{
  "holeCards": "22",
  "exists": true,
  "actions": [
    {
      "actionName": "fold",
      "actionSize": 0,
      "amountBB": 0,
      "frequency": 0.0016678530955687165,
      "handEV": 0,
      "exists": true
    }
  ]
}
```

## 代码内读取方式

### 方案二 + Rust（推荐，性能最优）

```ts
import { Scheme2QueryService } from "./src/scheme2/query/query-service";

const service = new Scheme2QueryService("range-db/binary-scheme2/meta.db", "range-db/binary-scheme2", {
  verifyChecksums: false,
});

// 预热维度（同步调用，Rust DimensionHandle mmap .idx + .bin）
service.prewarmDimension({ strategy: "default", playerCount: 6, depthBb: 100 });

// 查询手牌策略（同步热路径，Rust 内部完成 二分查找 + 解码）
const strategy = service.getHandStrategySync({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "22",
});
// → { holeCards: "22", exists: true, actions: [{ actionName: "fold", frequency: 0.0017, ... }] }

// 异步版本（自动预热 + 查询，首次调用时打开文件）
const strategy2 = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 2,
  holeCards: "AA",
});

// 批量查询（Rust queryBatch 原生支持）
const batch = await service.getHandStrategiesBatch({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [
    { concreteLineId: 1, holeCards: "AA" },
    { concreteLineId: 1, holeCards: "AKs" },
  ],
});

// Drill 场景 → 具体行动线
const lines = service.getDrillScenarioLines({ drillName: "UTG", playerCount: 6 });
const concrete = service.getConcreteLines({ playerCount: 6, depthBb: 100, abstractLine: lines[0] });

service.close();
```

### 方案一（SQLite 索引 + .bin）

```ts
import { PreflopQueryService } from "./src/query/preflop-query-service";

const service = new PreflopQueryService("range-db/binary/meta.db", "range-db/binary", {
  packCacheSize: 256,
});

const strategy = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "22",
});

// 批量查询、按 action 筛选、完整 range 等功能一致
const batch = await service.getHandStrategiesBatch({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [
    { concreteLineId: 1, holeCards: "AA" },
    { concreteLineId: 1, holeCards: "AKs" },
  ],
});

await service.close();
```

> 方案一和方案二的 API 接口基本一致，差异在于内部查询引擎（SQLite 索引 vs Rust .idx 二分查找）。
> 完整 SDK 文档见 `docs/query-sdk.md`。

## 二进制格式

每个 `ranges_*.bin` 以固定 16 字节 header 开头：

```text
magic[4]        = PFSP
version_u16     = 1
endian_u8       = 1   # little-endian
float_type_u8   = 1   # float32
layout_u8       = 1   # sparse hand-major v1
compression_u8  = 0   # none
header_size_u16 = 16
reserved[4]
```

每个 concrete line 对应一个 pack：

```text
hand_ids[hand_count]                         # uint8
action_masks[hand_count]                     # uint32_le
values[hand_count][action_count][2]          # float32_le
```

其中：

```text
values[..., 0] = frequency
values[..., 1] = hand_ev
```

`action_masks` 用来区分：

- 某 action 不存在
- 某 action 存在但 frequency 等于 0

## 生成物说明

### 方案一（`range-db/binary/`）

完整构建后至少包含：

```text
meta.db                                   # 87 MB（SQLite 索引 + 元数据）
ranges_default_{6max,8max,9max}_{100,200,300}BB.bin   # 9 个 .bin，共 ~260 MB
```

### 方案二（`range-db/binary-scheme2/`，推荐）

完整构建后至少包含：

```text
meta.db                                   # 74 MB（精简元数据 + action_schemas）
ranges_default_{6max,8max,9max}_{100,200,300}BB.idx   # 9 个 .idx，共 ~11 MB
ranges_default_{6max,8max,9max}_{100,200,300}BB.bin   # 9 个 .bin，共 ~260 MB
```

> 方案二总量 ~344 MB，为 SQLite 源库 (1,447 MB) 的 24%。

部署或后端读取时，需要保证：

- `meta.db` 存在。
- `.idx` 和 `.bin` 文件成对存在。
- `native-addon/` 已编译生成 `.node` 文件（Rust DimensionHandle 运行时依赖）。
- hand 代码必须来自固定 169 手牌字典，例如 `AA`、`AKs`、`AKo`、`22`。

## 开发注意事项

### TypeScript 侧
- 不要修改 `HANDS_169` 的顺序；顺序变化需要升级二进制版本。
- 默认线上查询不建议每次校验 CRC；发布前或 debug 时可以打开 `--verify-checksum`。
- `hand_ev` 为 `null` 时会在二进制中写入 `NaN`，读取时再转回 `null`。
- frequency 和 hand_ev 使用 Float32 保存，与旧 SQLite REAL 可能存在极小精度差。
- 原始 `range-db/range.db` 不会被 builder 原地修改。

### Rust 侧
- 修改 `native-addon/src/*.rs` 后必须重新编译：`cd native-addon && cargo test && napi build --release`
- Rust 测试独立于 Bun 测试：`cd native-addon && cargo test`
- `.idx` / `.bin` 文件格式变更需要同步更新 Rust `types.rs` 和 TypeScript `idx-types.ts`
- `napi build` 生成的 `index.js` 会根据 `process.config` 自动选择 `win32-x64-msvc.node` / `linux-x64-gnu.node` 等平台变体
- CRC32C 查找表在 Rust 编译期计算（`const`），零运行时开销
