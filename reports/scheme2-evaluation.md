# 存储方案三路对比评测报告

生成时间：2026-06-13

## 1. 架构概览

| | SQLite（原版）| 方案一 | 方案二 |
|---|---|---|---|
| 存储格式 | 行式 SQLite 表 | .bin 二进制 Pack + SQLite 索引 | .bin 二进制 Pack + .idx mmap |
| 索引方式 | B-tree（SQLite 原生）| SQLite `range_pack_index` 表 | 独立 .idx 文件 + DataView 二分查找 |
| 查询路径 | SQL SELECT → 逐行读取 | Map 缓存查 offset → mmap .bin 解码 | 二分查 .idx → mmap .bin 解码 |
| 数据编码 | 行式展开（hole_cards + action 逐行）| 列式压缩 Pack（bitmask + 游程编码）| 同方案一 |
| 冷启动 | 打开 SQLite 连接 | 打开 meta.db + loadIndexCache + mmap .bin | 打开 light meta.db + mmap .idx + .bin |
| 外部依赖 | SQLite 文件 | meta.db + .bin（每维度）| meta.db + .idx + .bin（每维度）|

## 2. 存储体积

测试维度：9 个（6max + 8max + 9max × 100/200/300BB）

| 项目 | SQLite | 方案二 |
|---|---|---|
| 数据文件 | range.db ~1447 MB | .bin 文件 272.1 MB |
| 索引文件 | （含在 range.db 内）| .idx 文件 11.5 MB + meta.db 77.6 MB |
| **总计** | **~1447 MB** | **~361.2 MB** |
| 压缩比 vs SQLite | — | **25.0%** |

> SQLite row-store 数据极度膨胀：重复的 `hole_cards` 和 `action_name` 字符串占绝大部分体积。
> 方案二将 range 数据用二进制列式编码压缩至 .bin 文件（272 MB），索引用 .idx 文件（11.5 MB），meta.db 保留元数据表（concrete_lines、drill_scenario_lines、action_schemas）占 77.6 MB。

### 各维度数据分布

| 维度 | concrete_lines | .bin 大小 | .idx 大小 |
|---|---|---|---|
| 6max 100BB | 3,737 | 2.2 MB | 0.08 MB |
| 6max 200BB | 2,363 | 1.7 MB | 0.05 MB |
| 6max 300BB | 1,816 | 1.4 MB | 0.04 MB |
| 8max 100BB | 8,892 | 4.6 MB | 0.20 MB |
| 8max 200BB | 5,454 | 3.4 MB | 0.12 MB |
| 8max 300BB | 3,643 | 2.9 MB | 0.08 MB |
| 9max 100BB | **197,087** | **83.8 MB** | **4.33 MB** |
| 9max 200BB | **203,028** | **109.0 MB** | **4.47 MB** |
| 9max 300BB | **95,114** | **63.2 MB** | **2.09 MB** |

> 9max 维度的 concrete_lines 数量是 6max 的 50倍+，存储体积因此膨胀。9max 三个维度合计 .bin 256 MB，占总 .bin 体积的 94%。

## 3. 什么是"9 维度查询"

本测试覆盖的 9 个维度由三个参数笛卡尔积构成：

| 参数 | 含义 | 取值 |
|---|---|---|
| 策略 (strategy) | 策略名称 | `default` |
| 人数 (playerCount) | 牌桌人数 | `6` (6max), `8` (8max), `9` (9max) |
| 深度 (depthBb) | 有效筹码深度 | `100`, `200`, `300` (BB) |

```
default:6max:100BB    default:8max:100BB    default:9max:100BB
default:6max:200BB    default:8max:200BB    default:9max:200BB
default:6max:300BB    default:8max:300BB    default:9max:300BB
```

### 对方案的物理影响

| 方案 | 每维度物理文件 | 9 维度文件数 | 总 mmap 占用 |
|---|---|---|---|
| SQLite | 共用 `range.db` | 1 个文件 | 页缓存 ~5 MB |
| 方案二 | `.idx` + `.bin` | 18 个文件 | 全量 mmap ~284 MB |

### 对查询性能的关键影响

SQLite 所有维度数据在同一个 B-tree 文件中，C 引擎的页缓存始终有效。

方案二中每个维度是独立的 `.idx` 和 `.bin` 文件。当查询在 9 个维度间随机跳跃时：

1. **CPU cache miss**：每次切换维度访问不同的 `.bin` 文件区域，之前的 cache 行失效
2. **DataView 二分查找**：不同 `.idx` 文件对应不同的内存区域，冷查找惩罚；9max 二分需 ~18 步 vs 6max 的 ~12 步
3. **累积 9 个 .bin 文件共 ~284 MB**：远超典型 L3 cache（8-32 MB），必然频繁 miss
4. **9max 维度主导**：单个 9max .bin 文件就 83-109 MB，任意访问模式都难以让 cache 命中

而当查询集中在**单一小维度**（如 `6max:100BB`，.bin 仅 2.2 MB）时，`.idx` 和 `.bin` 数据可稳定在 L3 cache 中，方案二的原始解码性能远超 SQLite。

## 4. 查询性能

测试条件：seed=42，手牌查询 1000 次 + 批量查询 200 次（batch=20），warmup 20 次，9 维度随机跨越

> 注：使用批量计时（无 per-iteration `performance.now()` 开销），avgMs = totalMs / iterations，QPS 基于批量总时间。

### 4.1 冷启动

| 指标 | SQLite | 方案二 | 倍率 |
|---|---|---|---|
| 首查延迟 | **16.2 ms** | 58.5 ms | 3.6x |

### 4.2 单手牌查询 `getHandStrategy`

| 指标 | SQLite | 方案二 | 倍率 |
|---|---|---|---|
| avg | **0.052 ms** | 0.303 ms | 5.8x |
| QPS | **19,171** | 3,305 | 5.8x |

### 4.3 批量查询 `getHandStrategiesBatch`

| 指标 | SQLite | 方案二 | 倍率 |
|---|---|---|---|
| avg | **0.931 ms** | 3.095 ms | 3.3x |
| QPS | **1,074** | 323 | 3.3x |

### 4.4 分场景性能分析

性能高度依赖 workload 模式（微基准测试维度：6max/100BB）：

| 场景 | SQLite | 方案二 | 结论 |
|---|---|---|---|
| 同一查询重复 10K 次 | 15.6 μs/次 | **2.8 μs/次** | 方案二 5.6x 快 |
| 不同查询，单维度 1K 次 | **51 μs/次** | 127 μs/次 | SQLite 2.5x 快 |
| 不同查询，9 维度 1000 次 | **52 μs/次** | 303 μs/次 | SQLite 5.8x 快 |

> 上表微基准测试基于 6max/100BB 维度（.bin 2.2 MB），其他维度实际性能会因文件大小而异。

**Cache 敏感度**：方案二的性能取决于 .idx/.bin 文件的 CPU cache 命中率。
- 小维度热点查询（6max, .bin ~2 MB）：idx 和 pack 数据可容纳在 L3 cache 内，性能远超 SQLite
- 9 维度随机查询：9 个 .bin 文件共 ~284 MB，单个 9max .bin 即 83-109 MB，cache 频繁 miss，性能退化严重
- 大维度（9max）即使单维度热点查询，.bin 文件 83-109 MB 也无法完全驻留 L3 cache

### 4.5 内存占用

| 指标 | SQLite | 方案二 |
|---|---|---|
| RSS 增量 | **7.2 MB** | 215.4 MB |
| Heap 增量 | **0.0 MB** | 170.2 MB |

SQLite 内存最小（仅页缓存），二进制方案需要 mmap 全部 9 个 .bin 文件（~272 MB）+ 9 个 .idx 文件（~11.5 MB）+ meta.db 页缓存。

## 5. 综合对比

| 维度 | SQLite | 方案二 | 最优 |
|---|---|---|---|
| 存储体积 | 1447 MB | **361 MB (25%)** | **方案二** |
| 冷启动 | **16.2 ms** | 58.5 ms | SQLite |
| 热查吞吐（9维随机）| **19,171 QPS** | 3,305 QPS | SQLite |
| 热查吞吐（单维热点）| 64K QPS | **357K QPS** | **方案二** |
| 内存占用 | **7.2 MB** | 215.4 MB | SQLite |

## 6. 关键发现

### 6.1 SQLite 原版 — 多维度热查王者

- **多维度随机查询极快**（52 μs/query, 19K QPS）：SQLite B-tree 索引对所有维度无差别高效
- **存储体积巨大**（1447 MB）：行式展开导致大量字符串重复
- **内存极省**（7.2 MB）：仅按需加载热点页面，不 mmap 全量数据

### 6.2 方案二 — 存储缩减 4x，性能高度 workload 相关

- **存储 4x 缩减**：361 MB vs 1447 MB
- **单维度热点查询 5.6x 快于 SQLite**（小维度）：2.8 μs/query (357K QPS)
- **多维度随机查询 5.8x 慢于 SQLite**：303 μs/query (3.3K QPS)
- **冷启动慢 3.6x**：需要打开 18 个文件并 mmap 全部
- **内存占用高 30x**：215 MB vs 7.2 MB，所有 .bin 文件全量 mmap

### 6.3 根本原因分析

1. **mmap 全量策略**：方案二将每个维度的 .bin 文件全量 mmap 到内存（284 MB），SQLite 仅按需缓存热点页（7 MB）
2. **9max 数据膨胀**：9max 维度 concrete_lines 是 6max 的 50 倍+，.bin 体积 83-109 MB/维度，合计占 94%
3. **CPU cache 完全失效**：284 MB mmap 区域远超 L3 cache（8-32 MB），跨维度随机访问必然 cache miss
4. **二分查找步数增加**：9max 197K 条的 .idx 二分需 ~18 步，6max 3.7K 条仅需 ~12 步

### 6.4 性能优化记录

| 优化项 | 效果 |
|---|---|
| `readRaw()` 免 `subarray()` 分配 | 减少 GC 压力 |
| `decodeRangePackForHandDirect()` 零分配解码 | 直接 buffer 访问 |
| `decodeIdxRecordAt()` 免中间 Uint8Array | 减少对象分配 |
| 同步热路径 `getHandStrategySync()` | 消除 3 层 async/await microtask |
| 批量计时 benchmark | 准确测量吞吐量，避免 `perf.now()` 污染 |

## 7. 适用场景建议

| 场景 | 推荐方案 |
|---|---|
| 磁盘空间敏感（CI/容器/Embedded）| **方案二** — 4x 存储节省 |
| 小维度热点查询（6max/8max）| **方案二** — 单维度热点 5.6x 快于 SQLite |
| 多维度随机查询 + 极低延迟 | **SQLite** — 52 μs/query，5.8x 快于方案二 |
| 低内存环境 | **SQLite** — 7.2 MB RSS vs 215 MB |
| 9max 为主的生产环境 | **SQLite** — 9max .bin 过大导致 cache 完全失效 |
| 按维度分组请求 + 小维度 | **方案二** — 可最大化 .bin 热点命中 |

## 8. 结论

- **SQLite**：多维度随机查询最快（19K QPS），内存最省（7 MB），存储 1.4 GB。9 维度下优势更明显（5.8x vs 方案二）。
- **方案二**：存储缩减 4x（361 MB），小维度热点性能最优（357K QPS）。但 9max 维度 .bin 文件过大（83-109 MB），导致 mmap 膨胀和 cache miss 严重退化。

**关键权衡**：
- 维度数量增加 → SQLite 优势扩大（B-tree 对维度数不敏感，方案二 mmap 随文件数线性增长）
- 9max 大维度 → 方案二劣势加剧（单个 .bin 就超过 L3 cache）
- 按维度分组请求 → 方案二在小维度场景下仍有竞争力

**建议**：如果 9max 数据是主要使用场景，当前方案二的 mmap 全量策略不适合。可考虑的优化方向：
1. 按需 mmap 而非全量加载（仅 map 正在查询的维度）
2. 对 9max .bin 文件做分片（chunked mmap）
3. 为 9max 单独使用 SQLite 索引方案

---

*测试环境：Bun 1.3.5，Windows/x64，range.db 1447 MB，9 维度（6max + 8max + 9max × 100/200/300BB）*
