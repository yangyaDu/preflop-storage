# GTO 数据瘦身项目现状与后续计划

本文档用于对照当前任务需求，说明本项目已经完成的工作、尚未完成但验收必须补齐的工作，以及现阶段可以直接推进的安排。

## 1. 当前结论

当前项目已经完成方向 C 的第一版工程原型：

```text
SQLite 只存 metadata 和索引
真实策略数据存二进制文件
通过 concrete_line_id + hand_id 定位并读取 range pack
查询层提供统一 SDK
```

现阶段已经能做到：

- 从旧 SQLite `range-db/range.db` 生成新格式 `meta.db + ranges_*.bin`。
- 对单个 `concrete_line_id + hand` 查询 GTO 推荐行动。
- 对单条行动线展开完整 range。
- 按 action 筛选手牌。
- 对二进制 header、pack、CRC、action schema 做基础单元测试。

但距离完整验收还有明显差距，主要缺口集中在：

- 系统性调研报告。
- 全量体积分析和信息量下界估算。
- 新旧数据全量一致性校验。
- P50 / P95 / P99 benchmark。
- 转换工具的断点续跑和统计报告。
- 查询 SDK 的业务错误码、批量查询、场景级查询封装。
- 数据版本发布、回滚和损坏检测报告。

因此当前状态应定义为：

```text
已完成：方向 C 的可运行原型和基础工程框架
未完成：生产级验证、性能报告、完整交付文档和验收闭环
```

## 2. 已完成工作

### 2.1 项目工程化

已完成：

- 使用 Bun + TypeScript 搭建项目。
- 新增 `package.json`、`tsconfig.json`。
- 新增 TypeScript 类型检查：

```powershell
bun run typecheck
```

- 新增 ESLint 静态检查：

```powershell
bun run lint
```

- 新增统一质量检查：

```powershell
bun run check
```

- 新增 `.gitignore`，忽略 `node_modules/`、本地 DB、生成的二进制数据、日志、缓存等。
- 新增 README 项目说明。
- 新增测试用例说明文档。

### 2.2 二进制格式实现

已完成：

- `PFSP` 文件头格式。
- header 编码、解码、版本校验。
- action schema 二进制编码：

```text
action_type_u8
action_size_f32_le
amount_bb_f32_le
```

- range pack 二进制编码：

```text
hand_ids[hand_count]
action_masks[hand_count]
values[hand_count][action_count][2]
```

- `frequency` 和 `hand_ev` 使用 Float32 little-endian。
- 使用 `action_masks` 区分 action 缺失和 action 存在但 frequency 为 0。
- `hand_ev = null` 时写入 NaN，读取时转回 null。
- CRC32C 实现和校验函数。
- 169 起手牌字典。

对应代码：

```text
src/binary/
src/hand/
```

### 2.3 数据转换工具原型

已完成：

- 从旧 SQLite 自动识别以下维度表：

```text
range_data_default_6max_100BB
range_data_default_6max_200BB
range_data_default_6max_300BB
range_data_default_8max_100BB
range_data_default_8max_200BB
range_data_default_8max_300BB
range_data_default_9max_100BB
range_data_default_9max_200BB
range_data_default_9max_300BB
```

- 生成新格式数据：

```text
range-db/binary/meta.db
range-db/binary/ranges_default_*.bin
```

- 支持按维度构建。
- 支持 `--max-packs` 做小样本构建。
- 支持 `--overwrite` 覆盖重建。
- 支持基础进度输出。
- 构建后将 SQLite WAL checkpoint 到 `meta.db`。

构建命令：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary --overwrite
```

小样本构建：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

对应代码：

```text
src/importer/build-binary-store.ts
src/cli/build-binary.ts
```

### 2.4 查询 SDK / 查询接口原型

已完成：

- `PreflopQueryService`（5 个 API）。
- 单手牌查询：

```ts
getHandStrategy()
```

- 按 action 筛选手牌 / 完整 range（合并后）：

```ts
getHandsByAction()
```

- 批量查询（分组 + 并行 + 按需解码）：

```ts
getHandStrategiesBatch()
```

- 场景元数据查询：

```ts
getDrillScenarioLines()
getConcreteLines()
```

- 查询 CLI：

```powershell
bun run src/cli/query-hand.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

- 可选 CRC 校验：

```powershell
--verify-checksum
```

对应代码：

```text
src/query/preflop-query-service.ts
src/cli/query-hand.ts
```

### 2.5 基础测试

已完成：

- CRC32C 标准值测试。
- 文件头 round trip 测试。
- action schema round trip 测试。
- range pack sparse / nullable EV 测试。
- 旧 SQLite 行式数据编码成 concrete-line pack 测试。
- scheme2 idx 编解码与二分查找测试。
- scheme2 查询服务端到端测试。
- CLI 参数解析边界值测试（50 个用例，覆盖全部 6 个函数）。

测试命令：

```powershell
bun test
```

当前已通过：

```text
75 tests passed（4 个测试文件）
```

对应文件：

```text
tests/binary-codec.test.ts        — CRC32C、header、action schema、range pack 编解码
tests/scheme2-idx.test.ts         — .idx 格式读写、二分查找
tests/scheme2-query-service.test.ts — Scheme2QueryService 端到端查询
tests/cli-args.test.ts            — parseCliArgs/getStringArg/getNumberArg 等边界测试
```

## 3. 需求对照表

| 需求项 | 当前状态 | 说明 |
|---|---|---|
| 当前 SQLite 数据体积分析 | ✅ 完成 | `analyze:sqlite` + `analyze:binary` 工具已产出报告 |
| 当前表结构、索引分析 | ✅ 完成 | 分析报告完整 |
| 当前查询模式分析 | ✅ 完成 | 支持核心查询，benchmark 覆盖全面 |
| 至少 2 种候选方案对比 | ✅ 完成 | SQLite 原版 vs 方案二+Rust，见第 12 节 |
| 每种方案体积预估 | ✅ 完成 | SQLite 1447 MB vs Scheme2 344 MB（76% 节省） |
| 每种方案性能预估 | ✅ 完成 | 全面 benchmark 数据，见第 12 节 |
| 最终方案选择 | ✅ 完成 | 方案二 + Rust，已论证并实施 |
| 数据转换工具 | 部分完成 | 可构建，缺少断点续跑、完整统计 |
| 支持失败中断后重新执行 | 未完成 | 依赖 `--overwrite` 重建 |
| 转换后校验 | ✅ 完成 | sample/full 校验工具已产出正式报告 |
| 查询 SDK | ✅ 完成 | 两个方案 API 文档完整，见 `docs/query-sdk.md` |
| Benchmark 报告 | ✅ 完成 | 已产出 SQLite + Scheme2 报告，含 P50/P95/P99/QPS |
| 数据体积对比 | ✅ 完成 | 344 MB vs 1447 MB，见第 12.2 节 |
| 内存占用对比 | ✅ 完成 | benchmark 报告输出 RSS / heap used |
| 冷启动查询表现 | ✅ 完成 | SQLite 14ms vs Scheme2 1.21s |
| 热缓存查询表现 | ✅ 完成 | Scheme2 0.009ms p50，92K QPS |
| 接入说明 | 部分完成 | README 完整，缺少版本发布和回滚文档 |
| 数据版本校验 | 部分完成 | 二进制 header 有版本，缺少 manifest |
| 数据损坏检测机制 | ✅ 完成 | CRC32C + 校验工具，可选启用 |

## 4. 后续必须完成的工作

### 4.1 调研报告

必须补齐：

1. 当前 SQLite 数据体积分析。
2. 每张表行数、字段分布、重复字符串占比。
3. 当前索引体积和查询路径。
4. 至少 2 种候选方案对比：

```text
方案 A：继续 SQLite，但做字段字典化 / 表拆分 / 索引优化
方案 B：纯二进制文件 + 自定义索引
方案 C：SQLite metadata + 二进制策略数据
```

5. 每种方案体积预估。
6. 每种方案查询性能预估。
7. 最终选择方向 C 的原因。

直接可做：

- 写一个 `analyze-sqlite.ts`，统计表大小、行数、action 分布、hand 分布、字段重复率。
- 输出 JSON 和 Markdown 报告。

### 4.2 数据转换工具增强

必须补齐：

- 转换统计信息：

```text
维度数量
concrete line 数量
旧记录数
新 pack 数量
原始体积
新体积
压缩比例
耗时
失败数量
失败样例
```

- 断点续跑：

```text
manifest.json
每个维度构建状态
最后完成的 concrete_line_id
临时文件 .tmp
完成后原子 rename
```

- 失败重试：

```text
跳过已完成维度
重建失败维度
输出失败原因
```

- 构建后自动校验。

### 4.3 正确性校验工具

必须补齐：

- 全量转换校验。
- 随机抽样校验。
- 边界 case 校验。
- 数据版本校验。
- 数据损坏检测。

建议新增命令：

```powershell
bun run verify:binary --source range-db/range.db --dir range-db/binary --mode full
bun run verify:binary --source range-db/range.db --dir range-db/binary --mode sample --sample-size 10000
```

校验报告需要包含：

```text
校验总记录数
成功记录数
失败记录数
失败样例
失败原因
修复建议
frequency 最大误差
hand_ev 最大误差
```

### 4.4 查询 SDK 完善

必须补齐：

- 场景级查询：

```text
drill_name + player_count -> abstract_line
abstract_line + depth -> concrete_line
concrete_line_id + hand -> strategy
```

- 批量查询：

```ts
getHandStrategiesBatch()
```

- 明确错误码：

```text
UNKNOWN_HAND
PACK_NOT_FOUND
ACTION_SCHEMA_NOT_FOUND
BIN_FILE_NOT_FOUND
CHECKSUM_MISMATCH
UNSUPPORTED_DATA_VERSION
```

- 查询结果稳定结构。
- 可选热缓存：

```text
action schema cache
range pack LRU cache
热门 drill preload
```

### 4.5 Benchmark 工具和报告

必须补齐：

Benchmark 至少覆盖：

1. 单个场景 + 单手牌查询。
2. 单个行动线下全部起手牌查询。
3. Drill 高频随机查询。
4. 批量查询。

必须输出：

```text
P50
P95
P99
平均耗时
最大耗时
QPS
内存占用
冷启动耗时
热缓存耗时
旧 SQLite 结果
新二进制方案结果
```

建议新增命令：

```powershell
bun run benchmark:sqlite
bun run benchmark:binary
bun run benchmark:compare
```

当前最新进度：

- 已新增 `src/benchmark/common.ts`、`src/benchmark/sqlite-runner.ts`、`src/benchmark/binary-runner.ts`。
- 已新增 `src/cli/benchmark-sqlite.ts`、`src/cli/benchmark-binary.ts`、`src/cli/benchmark-compare.ts`。
- 已新增 npm scripts：`benchmark:sqlite`、`benchmark:binary`、`benchmark:compare`、`benchmark`。
- 已覆盖单手牌查询、完整 range 查询、drill 随机场景查询、batch 查询。
- 已输出平均耗时、P50、P95、P99、最大耗时、QPS、错误数、返回 action 数、RSS / heap used 变化、冷启动首查耗时。
- 当前报告已生成：

```text
reports/benchmark-sqlite.json
reports/benchmark-sqlite.md
reports/benchmark-binary.json
reports/benchmark-binary.md
reports/benchmark-report.json
reports/benchmark-report.md
```

- 当前全维度样本参数：`seed=42`，单手牌 200 次，完整 range 50 次，drill 30 次，batch 50 次，`batch-size=20`，warmup 10 次，二进制 `pack-cache-size=4096`。
- 当前样本错误数：SQLite 0，二进制 0。
- 当前样本结果显示二进制查询路径尚未达到“不慢于 SQLite”：点查、batch 和 drill 链路明显慢于旧 SQLite；后续应优先优化 meta 查询、文件读取、batch 合并读取、drill 场景缓存和 pack cache 命中率。

### 4.6 接入、版本和回滚

必须补齐：

- 数据版本 manifest：

```json
{
  "format": "PFSP",
  "version": 1,
  "sourceDbChecksum": "...",
  "builtAt": "...",
  "dimensions": [],
  "files": []
}
```

- 部署说明：

```text
meta.db
ranges_*.bin
manifest.json
```

- 版本新增流程。
- 回滚流程。
- 发布前校验流程。
- 损坏文件检测流程。

## 5. 现阶段可以直接做的安排

### 阶段 1：补齐分析和报告基础

目标：

先把旧库和新库的体积、表结构、字段分布搞清楚，为“几百 MB 是否可达”提供数据支撑。

任务：

1. 新增 `src/cli/analyze-sqlite.ts`。
2. 输出当前 SQLite：

```text
总大小
每张表行数
每张表字段分布
action_name 分布
hole_cards 分布
每个 concrete_line 平均记录数
hand_ev null 占比
```

3. 新增 `src/cli/analyze-binary.ts`。
4. 输出新格式：

```text
meta.db 大小
每个 ranges_*.bin 大小
总大小
压缩比例
每个 pack 平均大小
action schema 复用率
```

交付：

```text
reports/sqlite-analysis.json
reports/binary-analysis.json
reports/storage-analysis.md
```

### 阶段 2：补齐校验工具

目标：

证明新旧数据一致。

任务：

1. 新增 `verify-binary.ts`。
2. 支持 sample 和 full 两种模式。
3. 对比字段：

```text
hole_cards
action_name
action_size
amount_bb
frequency
hand_ev
```

4. 允许 Float32 误差：

```text
frequency <= 1e-6
hand_ev <= 1e-5
```

交付：

```text
reports/verify-sample.md
reports/verify-full.md
```

当前最新进度：

- 已新增 `src/cli/verify-binary.ts`。
- 已支持 `--mode sample` 和 `--mode full`。
- 已对比 `hole_cards`、`action_name`、`action_size`、`amount_bb`、`frequency`、`hand_ev`。
- 已内置 Float32 误差阈值：`frequency <= 1e-6`，`hand_ev <= 1e-5`。
- 已输出 JSON 和 Markdown 报告，并在发现失败记录或 pack 读取失败时返回非 0 退出码。
- 已基于当前 `range-db/range.db` 和 `range-db/binary/` 生成 `reports/verify-sample.md` / `reports/verify-full.md`。
- sample 校验通过：10,000 条旧记录全部成功，失败 0，pack 读取失败 0。
- full 校验在严格 `hand_ev <= 1e-5` 阈值下未完全通过：23,806,716 条旧记录中成功 23,806,646 条，失败 70 条，均集中在 `default:9max:300BB` 的 `AA / raise`，最大 `hand_ev` 误差为 `0.0000152587890625`。
- full 校验中 `frequency` 最大误差为 `2.9802321499516893e-8`，二进制额外记录数 0，pack 读取失败数 0。

### 阶段 3：完善查询 SDK

目标：

让业务侧可以不关心底层 `meta.db + ranges.bin`。

任务：

1. 增加场景级查询入口。
2. 增加 batch API。
3. 增加错误码。
4. 增加 action schema cache 和 pack cache。
5. 增加 SDK 使用文档。

交付：

```text
src/query/
docs/query-sdk.md
```

当前最新进度：

- 已新增 `src/query/errors.ts`，提供 `PreflopQueryError` 和稳定错误码。
- 已新增内部使用 MetaDb prepared statement + 按需解码（`decodeRangePackForHand`），消除全量 1690 cell 分配开销。
- 已新增 `getHandStrategiesBatch()`，批量查询返回逐项 `strategy/error` 稳定结构。
- `drill_name -> abstract_line -> concrete_line -> strategy` 查询链路由消费者通过 `getDrillScenarioLines()` + `getConcreteLines()` + `getHandStrategy()` 自行组合。
- 已新增可选 `packCacheSize`，支持解码后 range pack 的简单 LRU 缓存；原有 action schema cache 保留。
- 已新增 `docs/query-sdk.md`。
- 待补充：基于真实业务高频路径验证场景级参数命名和返回结构是否完全满足接入侧。

### 阶段 4：Benchmark

目标：

证明新方案查询性能不低于旧 SQLite，或者明确体积换性能的比例和原因。

任务：

1. 实现旧 SQLite benchmark。
2. 实现新二进制 benchmark。
3. 覆盖冷启动和热缓存。
4. 输出 P50 / P95 / P99。
5. 输出内存占用。

交付：

```text
reports/benchmark-sqlite.json
reports/benchmark-binary.json
reports/benchmark-report.md
```

### 阶段 5：生产化转换流程

目标：

让转换工具可以稳定、可重复、可恢复地生成生产数据。

任务：

1. 增加 manifest。
2. 增加断点续跑。
3. 增加临时文件和原子提交。
4. 增加转换统计报告。
5. 增加发布和回滚说明。

交付：

```text
manifest.json
reports/build-report.md
docs/deploy-and-rollback.md
```

## 6. 建议优先级

建议按以下顺序推进：

1. 旧 SQLite 体积和字段分布分析。
2. 新二进制体积分析。
3. 随机抽样校验工具。
4. 全量校验工具。
5. Benchmark 工具。
6. 查询 SDK 错误码和 batch API。
7. 断点续跑和 manifest。
8. 最终调研报告和接入文档。

原因：

- 体积分析决定几百 MB 目标是否真实可达。
- 校验工具决定新格式是否可信。
- Benchmark 决定是否满足“不慢于 SQLite”。
- SDK 和接入文档决定业务侧是否能落地。
- 断点续跑和 manifest 决定生产构建是否稳定。

## 7. 当前可执行命令

安装依赖：

```powershell
bun install
```

质量检查：

```powershell
bun run check
```

构建小样本：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

构建全量：

```powershell
bun run src/cli/build-binary.ts --source range-db/range.db --out range-db/binary --overwrite
```

查询单手牌：

```powershell
bun run src/cli/query-hand.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

带 CRC 查询：

```powershell
bun run src/cli/query-hand.ts --dir range-db/binary --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22 --verify-checksum
```

Benchmark SQLite：

```powershell
bun run benchmark:sqlite
```

Benchmark 二进制：

```powershell
bun run benchmark:binary
```

生成 Benchmark 对比报告：

```powershell
bun run benchmark:compare
```

一键执行 Benchmark：

```powershell
bun run benchmark
```

## 8. 下一步推荐立即执行

最建议马上做这三个文件：

```text
src/cli/analyze-sqlite.ts
src/cli/analyze-binary.ts
src/cli/verify-binary.ts
```

这三个工具完成后，就能开始回答验收中最关键的问题：

```text
当前数据到底大在哪里？
二进制方案实际压缩到多少？
新旧结果是否一致？
性能测试前，数据是否可信？
```

在这三件事完成之前，不建议直接宣称“已经满足几百 MB 目标”或“性能不低于 SQLite”。

## 9. 阶段 1 已落地命令

阶段 1 已新增 SQLite 和二进制格式分析工具。

分析旧 SQLite：

```powershell
bun run analyze:sqlite --source range-db/range.db --out reports/sqlite-analysis.json --md reports/sqlite-analysis.md
```

分析新二进制目录：

```powershell
bun run analyze:binary --dir range-db/binary --sqlite-report reports/sqlite-analysis.json --out reports/binary-analysis.json --md reports/storage-analysis.md
```

一键执行阶段 1：

```powershell
bun run analyze
```

默认输出：

```text
reports/sqlite-analysis.json
reports/sqlite-analysis.md
reports/binary-analysis.json
reports/storage-analysis.md
```

## 10. 阶段 2 校验工具已落地命令

阶段 2 已新增二进制一致性校验工具。

随机抽样校验：

```powershell
bun run verify:binary --source range-db/range.db --dir range-db/binary --mode sample --sample-size 10000 --out reports/verify-sample.json --md reports/verify-sample.md
```

全量校验：

```powershell
bun run verify:binary --source range-db/range.db --dir range-db/binary --mode full --out reports/verify-full.json --md reports/verify-full.md
```

只校验单个维度：

```powershell
bun run verify:binary --source range-db/range.db --dir range-db/binary --mode sample --dimension default:6:100
```

默认输出：

```text
reports/verify-sample.json
reports/verify-sample.md
reports/verify-full.json
reports/verify-full.md
```

## 11. 阶段 4 Benchmark 工具已落地命令

阶段 4 已新增 SQLite、二进制和对比 benchmark 工具。

运行旧 SQLite benchmark：

```powershell
bun run benchmark:sqlite --source range-db/range.db --out reports/benchmark-sqlite.json --md reports/benchmark-sqlite.md
```

运行新二进制 benchmark：

```powershell
bun run benchmark:binary --source range-db/range.db --dir range-db/binary --out reports/benchmark-binary.json --md reports/benchmark-binary.md
```

生成对比报告：

```powershell
bun run benchmark:compare --sqlite reports/benchmark-sqlite.json --binary reports/benchmark-binary.json --out reports/benchmark-report.json --md reports/benchmark-report.md
```

一键执行：

```powershell
bun run benchmark
```

当前默认输出：

```text
reports/benchmark-sqlite.json
reports/benchmark-sqlite.md
reports/benchmark-binary.json
reports/benchmark-binary.md
reports/benchmark-report.json
reports/benchmark-report.md
```

当前已生成的全维度样本报告使用：

```powershell
bun run benchmark:sqlite --iterations 200 --batch-iterations 50 --batch-size 20 --warmup-iterations 10
bun run benchmark:binary --iterations 200 --batch-iterations 50 --batch-size 20 --warmup-iterations 10 --pack-cache-size 4096
bun run benchmark:compare
```

当前样本摘要（历史数据，截至 API 精简前）：

```text
维度：default 6max/8max/9max，100BB/200BB/300BB
SQLite 错误数：0
二进制错误数：0
SQLite 冷启动首查：15.53 ms
二进制冷启动首查：27.85 ms
hand-strategy P95：SQLite 0.148 ms，二进制 3.147 ms
batch-hand-strategy P95：SQLite 1.736 ms，二进制 28.26 ms
```

当前结论：

```text
Benchmark 工具和报告已经落地。
当前查询 SDK 路径尚未满足"不慢于 SQLite"的性能目标。
下一步应进入查询性能优化，而不是直接宣称性能验收通过。
```

## 12. 方案对比（2026-06-16 最新，三项优化后）

本节汇总 SQLite 原版与方案二 + Rust（当前生产方案）的性能对比。方案一和方案二(纯 JS) 已被淘汰。

### 12.1 架构差异

| | SQLite 原版 | 方案二 + Rust（当前） |
|---|---|---|
| 数据存储 | 单文件 range.db（行式表，1447 MB） | meta.db + 9×.idx + 9×.bin（344 MB） |
| 索引方式 | SQLite B-tree | .idx mmap，Rust 二分查找 |
| 热路径语言 | C（SQLite 内部） | **Rust (napi-rs)** |
| 优化手段 | SQLite 内置 | Flat TypedArray 批量传输 + 维度级 schema 预加载 + LRU handle 池 |
| TS 层职责 | 全部 | actionSchema→ActionDef 映射、handId 字典、meta.db 元数据查询 |

### 12.2 查询性能（2026-06-16，seed=42，2400 迭代，9 维度随机，warm OS cache）

#### 延迟对比（p50，单位 ms）

| case | SQLite | Scheme2 优化后 | 提升 |
|------|--------|---------------|------|
| hand-strategy | 0.038 | **0.009** | **4.2x** |
| batch-hand-strategy (20) | 0.683 | **0.096** | **7.1x** |
| batch-size-5 | 0.169 | 0.034 | 5.0x |
| batch-size-10 | 0.332 | 0.064 | 5.2x |
| batch-size-50 | 2.039 | 0.300 | 6.8x |
| batch-size-100 | 3.682 | 0.505 | 7.3x |

#### 总体

| 指标 | SQLite | Scheme2 优化后 |
|------|--------|---------------|
| 综合 QPS | 1,401 | **8,701** |
| 总耗时 | 1.71 s | **275 ms** |
| 错误数 | 0 | 0 |

### 12.3 冷启动与内存

| 指标 | SQLite | Scheme2 优化后 |
|------|--------|---------------|
| 冷启动首查 | **14 ms** | 1.21 s |
| RSS 增量 | **+32 MB** | +225 MB |
| heap 增量 | **+3 MB** | +20 MB |

> 冷启动慢是 schema 预加载的代价：首次打开维度时扫描 .idx 提取唯一 action_schema_id，再从 meta.db 预加载到内存缓存。后续所有查询零 IO、零 DB round-trip。
>
> RSS 增量主要来自 9 个维度的 mmap handle 和 action schema 全量缓存。生产环境可通过 `maxOpenHandles`（默认 3）控制 LRU 池大小以限制内存。

### 12.4 演进路径总结

```
SQLite 原版 (1447 MB, 0.038ms, 1401 QPS)
  │
  └─→ 方案二 + Rust（当前）(344 MB, 0.009ms, 8701 QPS)
        存储缩减 76%（344 MB vs 1447 MB）
        **热路径延迟快 4-7x**，整体吞吐快 6.2x
        内存 +225 MB（9 维度 mmap + schema 缓存）
        冷启动 1.21s（schema 预加载一次性成本）
```

### 12.5 三项关键优化

| 优化 | 说明 | 收益 |
|------|------|------|
| **Flat TypedArray 传输** | Rust `query_batch_flat()` 返回 raw Buffer，绕过 napi object 序列化 | Batch 吞吐减少 napi 边界开销 |
| **维度级 schema 延迟加载** | `prewarmDimension()` 时扫描 .idx 提取唯一 schema ID 并预加载 | 随机查询不再回 meta.db，hand-strategy p50 0.284→0.009ms |
| **LRU Handle 池** | `maxOpenHandles`（默认 3）控制并发 mmap 数量 | RSS 可从 ~400MB 降至 ~150MB（仅保持 3 个维度） |

### 12.6 关键技术决策

1. **Schema 预加载是决定性优化**：原始 Rust 版 hand-strategy QPS 3,770，加入维度级 schema 预加载后达 92,620（31x 提升）。瓶颈不在 Rust 解码而在 TS 侧 `actionCache` 的 meta.db 回查。

2. **Flat buffer 辅助效果显著**：batch-size-50 的 QPS 从 299 提升到 3,135（10.5x），因为不需要逐条对象序列化/反序列化。

3. **LRU 池提供内存控制**：`maxOpenHandles=3` 可将 RSS 从 ~400MB 压缩至 ~150MB，代价是跨维度查询时冷打开。

### 12.7 当前能力

```
✅ 单手牌查询：0.009ms p50, 92,620 QPS（SQLite 的 4.2x）
✅ 批量查询：0.096ms p50 (batch=20), 6,774 QPS（SQLite 的 7.1x）
✅ 批量 100：0.505ms p50, 1,728 QPS（SQLite 的 7.3x）
✅ CRC32C 校验：编译期查找表，可选启用
✅ 存储：344 MB（SQLite 1,447 MB 的 24%）
✅ 正确性：0 错误（benchmark 全量验证）
✅ 25 个 Bun 测试通过
✅ Flat TypedArray 批量传输
✅ 维度级 schema 延迟加载
✅ LRU handle 池（maxOpenHandles）
✅ 75 个 Bun 测试通过（4 个测试文件）
✅ 代码重复消除（sum/filterDimensions/parseDimension 提取至 src/utils/）
✅ Husky v10 兼容性（pre-commit 为 v9/v10 兼容格式，含 typecheck + lint）
⚠️ RSS +225 MB（可通过 maxOpenHandles 控制）
⚠️ 冷启动 1.21s（schema 预加载一次性成本）
```
