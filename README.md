# Preflop Storage

Preflop Storage 是一个基于 Bun + TypeScript 的德州扑克翻前策略二进制存储项目。

项目目标是把旧 SQLite 中逐行保存的 range 策略数据，转换为：

- `meta.db`：保存场景、抽象行动线、具体行动线、action schema、二进制文件索引。
- `ranges_*.bin`：保存真实手牌策略矩阵，使用固定 Float32 little-endian 二进制格式。

这样可以保留原来的三层查询能力，同时减少 SQLite 行式数据带来的体积膨胀。

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

  range-db/
    range.db                    # 旧 SQLite 源数据
    binary/                     # 完整二进制生成目录
      meta.db
      ranges_default_6max_100BB.bin
      ranges_default_6max_200BB.bin
      ...
    binary-smoke/               # 小样本验证目录

  src/
    binary/                     # 二进制格式、pack、header、CRC、reader/writer
    cli/                        # 命令行入口
    db/                         # meta.db 表结构与查询封装
    hand/                       # 169 手牌字典
    importer/                   # 旧 SQLite -> 二进制库构建器
    query/                      # 线上读取查询服务
    index.ts                    # 模块统一导出

  tests/
    binary-codec.test.ts
```

## 运行环境与依赖

需要安装：

- Bun 1.3 或更高版本

项目没有线上运行依赖，主要依赖 Bun 内置能力：

- `bun:sqlite`：Bun 内置 SQLite
- `node:fs/promises`：文件随机读写

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

确认 Bun 可用：

```powershell
bun --version
```

## 常用命令

运行测试：

```powershell
bun test
```

运行 TypeScript 类型检查：

```powershell
bun run typecheck
```

运行 lint 检查：

```powershell
bun run lint
```

运行完整质量检查：

```powershell
bun run check
```

分析旧 SQLite 数据：

```powershell
bun run analyze:sqlite --source range-db/range.db --out reports/sqlite-analysis.json --md reports/sqlite-analysis.md
```

分析新二进制数据，并生成体积对比报告：

```powershell
bun run analyze:binary --dir range-db/binary --sqlite-report reports/sqlite-analysis.json --out reports/binary-analysis.json --md reports/storage-analysis.md
```

一次性运行阶段 1 分析：

```powershell
bun run analyze
```

构建完整二进制库：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary --overwrite
```

也可以使用 package script：

```powershell
bun run build:binary --source range-db/range.db --out range-db/binary --overwrite
```

构建单个维度的小样本，用于快速验证：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

查询单手牌策略：

```powershell
bun run src/cli/query-hand.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

带 CRC 校验读取：

```powershell
bun run src/cli/query-hand.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22 --verify-checksum
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

后端服务中可以直接使用 `PreflopQueryService`：

```ts
import { PreflopQueryService } from "./src/query/preflop-query-service";

const service = new PreflopQueryService("range-db/binary/meta.db", "range-db/binary");

const strategy = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "22",
});

await service.close();
```

也可以查询完整 range：

```ts
const fullRange = await service.getFullRange({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
});
```

按 action 筛选手牌：

```ts
const raiseHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionName: "raise",
  minFrequency: 0.1,
});
```

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

完整构建后，`range-db/binary/` 下至少包含：

```text
meta.db
ranges_default_6max_100BB.bin
ranges_default_6max_200BB.bin
ranges_default_6max_300BB.bin
ranges_default_8max_100BB.bin
ranges_default_8max_200BB.bin
ranges_default_8max_300BB.bin
ranges_default_9max_100BB.bin
ranges_default_9max_200BB.bin
ranges_default_9max_300BB.bin
```

部署或后端读取时，需要保证：

- `meta.db` 存在。
- 能够通过 `strategy / playerCount / depthBb` 匹配到对应的 `range_pack_index_{strategy}_{playerCount}max_{depthBb}BB` 表。
- 根据维度推导出的二进制数据文件 `ranges_{strategy}_{playerCount}max_{depthBb}BB.bin` 在同一个 `--dir` 目录下存在。
- hand 代码必须来自固定 169 手牌字典，例如 `AA`、`AKs`、`AKo`、`22`。

## 开发注意事项

- 不要修改 `HANDS_169` 的顺序；顺序变化需要升级二进制版本。
- 默认线上查询不建议每次校验 CRC；发布前或 debug 时可以打开 `--verify-checksum`。
- `hand_ev` 为 `null` 时会在二进制中写入 `NaN`，读取时再转回 `null`。
- frequency 和 hand_ev 使用 Float32 保存，与旧 SQLite REAL 可能存在极小精度差。
- 原始 `range-db/range.db` 不会被 builder 原地修改。
