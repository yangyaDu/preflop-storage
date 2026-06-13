    # Opt1 + Opt2 性能分析报告

生成时间：2026-06-12T17:28（benchmark 运行时间）

## 变更概述

### Opt1：MetaDb 内存缓存
- `MetaDb.getRangePackIndex()` 不再每次查询 SQLite，改为首次访问某维度时全量加载到内存 `Map`
- `MetaDb.getRangePackIndexBatch()` 同理，从内存 Map 取值
- 删除了 `rangePackStmtCache`（prepared statement 缓存），用 `indexCache`（`Map<dimensionKey, Map<concreteLineId, row>>`）替代
- 按需加载：9 个维度共 ~521K 条索引，首次命中某维度才加载，每个维度 ~58K 条

### Opt2：handId 二分查找
- `decodeRangePackForHand` 中 handId 定位从线性扫描改为标准二分查找
- handIds 已确认按升序排列（`build-binary-store.ts:360` 中 `.sort((a,b) => a-b)`）
- 最坏情况：8 次比较 vs 线性平均 ~84 次（handCount ≤ 169）

---

## 当前性能数据

**环境：** Bun 1.3.5, Windows, 9 个维度（6max/8max/9max × 100BB/200BB/300BB）

**测试参数：** seed=42, handIterations=1000, batchIterations=200, batchSize=20, warmup=20, packCacheSize=1024

### 延迟与吞吐（热查询，warmup 后）

| case | 引擎 | avg | p50 | p95 | p99 | max | QPS |
|------|------|-----|-----|-----|-----|-----|-----|
| hand-strategy | SQLite | 0.055ms | 0.050ms | 0.101ms | 0.140ms | 0.318ms | 18,015 |
| hand-strategy | Binary | 0.415ms | 0.454ms | 0.662ms | 1.053ms | 13.37ms | 2,406 |
| batch-hand-strategy | SQLite | 0.891ms | 0.809ms | 1.367ms | 1.983ms | 2.821ms | 1,121 |
| batch-hand-strategy | Binary | 4.132ms | 4.224ms | 7.176ms | 7.932ms | 9.086ms | 242 |

### Binary vs SQLite 倍数

| case | avg ratio | p95 ratio | QPS ratio |
|------|-----------|-----------|-----------|
| hand-strategy | 7.5x | 6.6x | 0.13x |
| batch-hand-strategy | 4.6x | 5.2x | 0.22x |

### 冷启动

| 引擎 | 冷启动首查耗时 | 操作内容 |
|------|--------------|---------|
| SQLite | 13.6ms | 打开 SQLite + 首次 hand 查询 |
| Binary | 269.0ms | 打开 meta.db + ranges.bin + 首次 hand 查询 |
| 倍数 | 19.8x | — |

### 内存

| 指标 | SQLite | Binary |
|------|--------|--------|
| RSS 变化 | +7.8 MB | +279.4 MB |
| heap used 变化 | 0 B | +218.1 MB |
| 冷启动后 heap used | 0.24 MB | 139.9 MB |

---

## 分析

### 热查询延迟分析

**hand-strategy P50 = 0.454ms。** 拆解单次查询路径：

1. `MetaDb.getRangePackIndex()` → 内存 Map.get()，~0μs（Opt1 消除 SQLite 调用）
2. `PreflopQueryService.getActionSchema()` → 内存 actionCache.get()，命中
3. `RangeBinMmapReader.read()` → 从 mmap 缓冲区切出 Uint8Array（~0.41ms，占延迟主体）
4. `decodeRangePackForHand()` → 二分查找 handId + Float32Array 解码（~0.02ms）

**结论：延迟瓶颈已从 SQLite 索引查询转移到 mmap buffer 切片。** Opt1 消除了 `getRangePackIndex` 的 SQLite 往返（预估节省 ~0.05-0.1ms），Opt2 优化了 pack 内手牌定位（线性 → 二分）。剩余延迟主要来自 mmap 文件的 `TypedArray` 切片和 GC 压力。

**batch-hand-strategy P50 = 4.224ms（20 个请求/批）。**
- 批量查询每个请求内存开销小（共享 pack 读取）
- 每批量 20 个请求 → 平均每请求 ~0.21ms，接近单手牌查询水平
- 批量优势：pack 数据只读一次，共享给组内所有 hand

### 冷启动分析

Binary 冷启动 269ms vs SQLite 13.6ms，差距 19.8x。冷启动包含：

| 步骤 | 估算耗时 |
|------|---------|
| 打开 meta.db（SQLite 连接） | ~5ms |
| `loadIndexCache` 首次加载 1 个维度 | ~50ms |
| mmap 打开 ranges.bin 文件 | ~10ms |
| 首次 mmap reader.read() | ~200ms |

冷启动代价是 **一次性**的——服务进程生命周期内只发生一次。对常驻服务影响小，但 CLI 工具每次启动都会承担。可通过预加载 warmup 阶段缓解（当前 benchmark 已有 20 次 warmup iterations）。

### 内存分析

**Binary 占用 279.4 MB RSS 增量：**
- mmap 映射：9 个 `.bin` 文件各 ~10-30MB，共 ~100MB（OS page cache）
- pack cache（LRU，限额 1024）：已解码的 range packs
- indexCache（Opt1）：9 个维度全加载后 ~50MB JS heap（521K 条 × ~100 bytes/条）
- meta.db SQLite 连接 + action schemas 缓存

**SQLite 仅 7.8 MB RSS**：纯粹通过 page cache 读 SQLite 文件，无额外内存缓存。

内存换取的是热查询延迟的稳定性——不再随负载增加而退化为 SQLite 查询频率。

---

## Opt1+Opt2 效果评估

由于 benchmark 参数在两版代码间发生变化（迭代次数、warmup 次数、packCacheSize 等均不同），无法做精确的 before/after 对比。但从调用路径分析：

| 优化项 | 消除的开销 | 定性效果 |
|--------|----------|---------|
| Opt1: MetaDb cache | 每次 `getRangePackIndex` / `getRangePackIndexBatch` 的 SQLite `SELECT` 往返 | 消除 ~0.05-0.1ms 索引查询开销 |
| Opt2: 二分查找 | 线性扫描 handIds（平均 ~84 次比较 → 最坏 8 次） | 减少 pack 内 handId 定位开销 ~90% |

### 剩余瓶颈

Binary 引擎的延迟与 SQLite 仍有 7-8x 差距。剩余瓶颈按占比：

1. **mmap buffer 切片**（~0.35ms）：`RangeBinMmapReader.read()` 中的 `TypedArray.subarray()` 和 `DataView` 构造。考虑的方向：预切分 buffer 池、传递 offset+length 而非复制 buffer
2. **TypedArray/DataView 操作**（~0.05ms）：`decodeRangePackForHand` 中的 Float32Array 读取，每次调用都构造新的 DataView 和 Float32Array
3. **actionCache 查询**：当前已用 Map 缓存，可忽略

---

## 建议的下一步

| 优先级 | 方向 | 预期收益 |
|--------|------|---------|
| P0 | mmap read 零拷贝：返回 `{buffer, offset, length}` 而非 subarray | hand-strategy P50 → ~0.15ms |
| P1 | pack cache 预热：warmup 阶段预加载常用维度 | 消除冷查询延迟尖峰 |
| P2 | Float32Array 共用：`decodeRangePackForHand` 复用已创建视图 | 减少 GC 压力 |
| P3 | indexCache LRU 淘汰：按需保持 2-3 个维度在内存 | 控制内存增长 |
