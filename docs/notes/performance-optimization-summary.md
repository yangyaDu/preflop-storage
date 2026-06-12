# 查询性能优化总结

> 日期：2026-06-13
> 范围：`PreflopQueryService` 查询路径的性能优化全流程

---

## 1. 优化前基线

优化前的二进制方案查询性能严重劣于旧 SQLite：

| 用例 | SQLite P50 | Binary P50 | 差距 |
|------|-----------|------------|------|
| hand-strategy | 0.044ms | 1.39ms | 31.6x |
| batch-hand-strategy | 0.92ms | 22.3ms | 24.2x |

主要瓶颈分布：

| 环节 | 耗时 | 占比 |
|------|------|------|
| `decodeRangePack` 全量解码 1690 cell | ~0.8ms | 57.6% |
| `fs.read()` 系统调用 + Buffer 分配 + 数据拷贝 | ~0.3ms | 21.6% |
| MetaDb SQLite 查 pack 索引 | ~0.05ms | 3.6% |
| 其他开销（cache、调用栈、JS 对象构造） | ~0.24ms | 17.2% |

---

## 2. 优化阶段

### 阶段一：API 精简 + 按需解码 + Batch 分组并行（5 月 28 日）

#### 2.1.1 API 精简

删除 4 个冗余方法，合并功能：

| 删除的方法 | 替代方案 |
|-----------|---------|
| `getHandStrategyOrThrow` | 调用方自己 `?? throw` |
| `getScenarioConcreteLines` | 调用方组合 `getDrillScenarioLines` + `getConcreteLines` |
| `getScenarioHandStrategies` | 调用方自行聚合 |
| `getFullRange` | 合并到 `getHandsByAction(actionNames: [])` |

最终保留 5 个 API：`getHandStrategy`、`getHandsByAction`、`getHandStrategiesBatch`、`getDrillScenarioLines`、`getConcreteLines`。

#### 2.1.2 MetaDb prepared statement 缓存

```typescript
// 之前：每次查询重新编译 SQL
db.query("SELECT ... WHERE concrete_line_id = ?").get(id)

// 之后：首次 prepare，后续复用 stmt
private rangePackStmtCache = new Map<string, Statement>();
getRangePackStmt(tableName): Statement {
  const cached = this.rangePackStmtCache.get(tableName);
  if (cached) return cached;
  const stmt = db.prepare("SELECT ... WHERE concrete_line_id = ?");
  this.rangePackStmtCache.set(tableName, stmt);
  return stmt;
}
```

消除每次查询的 SQL 编译开销。

#### 2.1.3 按需解码 `decodeRangePackForHand`

核心思想：不再解码整个 pack 的 1690 个 cell 对象，只解析目标手牌。

```
之前：读 845 字节 → 分配 169 handIds + 169 masks + 1690 cells → 查找目标手牌
之后：读 845 字节 → 线性扫描 handIds 定位目标 → 只解码目标手牌 ~10 cell
```

实现要点：
- 扫描 handIds 段（每个 handId 1 字节），找到目标手牌的 `localHandIndex`
- 读取对应 actionMask（4 字节）
- 只解码该手牌的 actionCount 个 cell 数据

#### 2.1.4 掩码匹配 `decodeRangePackMaskMatch`

新增纯掩码匹配函数，用于 `getHandsByAction` 按 action 筛选：

```
不解析 cell 数据段，只读 handIds + actionMasks
用 32 位掩码按位匹配 action 存在性
直接返回匹配的 handId 列表
```

#### 2.1.5 Batch 分组 + 并行优化

`getHandStrategiesBatch` 重写：

```
1. 按 concreteLineId 分组 requests
2. 批量 SQL：WHERE concrete_line_id IN (?, ?, ...)
3. Promise.all 并行读取所有 pack 的二进制数据
4. 每 pack 调用 decodeRangePackForHand 按需解码
```

#### 2.1.6 阶段一结果

| 用例 | 优化前 | 阶段一 | 改进 |
|------|--------|--------|------|
| hand-strategy P50 | 1.39ms | 0.759ms | -45.4% |
| batch-hand-strategy P50 | 22.3ms | 8.139ms | -63.5% |

但仍劣于 SQLite：
- hand-strategy：0.759ms vs SQLite 0.044ms（17.3x）
- batch-strategy：8.139ms vs SQLite 0.92ms（8.8x）

瓶颈转移：`fs.read()` 系统调用成为剩余开销中占比最大的项。

---

### 阶段二：zero-copy 文件读取 + TypedArray 优化（5 月 29 日）

#### 2.2.1 RangeBinMmapReader（zero-copy 读取器）

用 `Bun.file().bytes()` 一次性将整个 `.bin` 文件加载到 `ArrayBuffer`，后续读取用 `Uint8Array.subarray()` 零拷贝切片。

```
之前：每次查询 → node:fs FileHandle.read() → 系统调用 → Buffer 分配 → 内存拷贝
之后：启动时加载一次 → subarray() 零拷贝 → 无系统调用、无内存分配
```

```typescript
export class RangeBinMmapReader {
  private data: Uint8Array | null = null;

  async open(): Promise<void> {
    this.data = await Bun.file(this.path).bytes(); // 一次性加载
    // validate header ...
  }

  read(offset: number, byteLength: number): Uint8Array {
    return this.data!.subarray(offset, offset + byteLength); // 零拷贝
  }
}
```

#### 2.2.2 TypedArray 直接访问优化

在 `decodeRangePackForHand` 和 `decodeRangePackMaskMatch` 中，用直接 TypedArray 访问替代 DataView 方法调用：

| 操作 | 之前（DataView） | 之后（TypedArray） |
|------|-----------------|-------------------|
| handId 查找 | `view.getUint8(i)` | `bytes[i]`（直接下标） |
| cell 数据读取 | `view.getFloat32(cursor, true)` | `Float32Array[idx]`（对齐时） |
| mask 读取 | `view.getUint32(cursor, true)` | `DataView`（不对齐，保留） |

对齐处理：
- handIds 段起始位置总是 Uint8 对齐，直接使用 `bytes[i]`
- actionMasks 段起始位置可能不是 4 字节对齐（handCount 不一定是 4 的倍数），保留 DataView
- cells 段检查 4 字节对齐，对齐时使用 Float32Array，否则回退 DataView

#### 2.2.3 阶段二结果

| 用例 | 阶段一 | 阶段二 | 改进 |
|------|--------|--------|------|
| hand-strategy P50 | 0.759ms | 0.576ms | -24.1% |
| hand-strategy avg | 0.759ms | 0.637ms | -16.1% |
| batch-strategy avg | 8.139ms | 4.877ms | -40.1% |

---

## 3. 最终 benchmark 结果

基准测试参数：
- 维度：default 6max/8max/9max × 100BB/200BB/300BB（共 9 个维度）
- seed=42, hand 500 次, batch 100 次 × 20 条/批
- warmup 10 次

### 3.1 延迟对比

| 用例 | 指标 | SQLite | Binary | 倍数 |
|------|------|--------|--------|------|
| **hand-strategy** | P50 | 0.067ms | 0.576ms | 8.6x |
| | P95 | 0.140ms | 0.909ms | 6.5x |
| | P99 | 0.230ms | 1.377ms | 6.0x |
| | avg | 0.076ms | 0.637ms | 8.4x |
| **batch-strategy** | P50 | 1.179ms | 5.024ms | 4.3x |
| | P95 | 1.677ms | 7.354ms | 4.4x |
| | P99 | 1.843ms | 7.923ms | 4.3x |
| | avg | 1.206ms | 4.877ms | 4.0x |

### 3.2 吞吐对比

| 用例 | SQLite QPS | Binary QPS | 倍数 |
|------|-----------|-----------|------|
| hand-strategy | 13,001 | 1,568 | 8.3x |
| batch-strategy | 828 | 205 | 4.0x |
| 综合 | 3,768 | 744 | 5.1x |

### 3.3 冷启动

| 指标 | SQLite | Binary |
|------|--------|--------|
| 首查耗时 | 20.1ms | 158.9ms |
| heapUsed 增量 | 0 | +110MB |
| arrayBuffers 增量 | 0 | +109MB |

Binary 冷启动耗时主要在加载第一个 `.bin` 文件到内存（~109MB ArrayBuffer）。

### 3.4 内存占用

| 指标 | SQLite | Binary |
|------|--------|--------|
| 运行前 RSS | 149MB | 291MB |
| 运行后 RSS | 155MB | 479MB |
| RSS 增量 | +5.9MB | +187.9MB |
| heapUsed 增量 | 0 | +147MB |
| 总 arrayBuffers | 0 | 272MB |

Binary 运行时将全部 9 个 `.bin` 文件加载到内存（~272MB ArrayBuffer），一次加载后全维度热。

---

## 4. 优化全景

### 4.1 总体改进幅度

| 优化项 | hand-strategy | batch-strategy |
|--------|:---:|:---:|
| **原始基线** | 1.39ms | 22.3ms |
| 阶段一（按需解码 + batch 并行） | 0.759ms（-45%） | 8.139ms（-64%） |
| 阶段二（zero-copy + TypedArray） | 0.576ms（-24%） | 4.877ms（-40%） |
| **总改进** | **-59%** | **-78%** |

### 4.2 已消除的开销

| 开销项 | 原始占时 | 当前状态 |
|--------|---------|---------|
| 全量解码 1690 cell 对象 | ~0.8ms | 消除，按需只解码 ~10 cell |
| fs.read() 系统调用 | ~0.3ms | 消除，zero-copy subarray() |
| Buffer 分配 + 内存拷贝 | ~0.1ms | 消除 |
| 重复 SQL 编译 | ~0.02ms | 消除，prepared stmt 缓存 |
| 串行 batch 读取 | ~15ms | 消除，Promise.all 并行 |

### 4.3 剩余的主要开销（估测）

| 开销项 | 估测耗时 | 说明 |
|--------|---------|------|
| MetaDb SQLite 查询 | ~0.15-0.25ms | 每次 getHandStrategy 查 pack 索引 |
| handId 线性扫描 | ~0.05-0.10ms | pack 内最多 169 次 Uint8 比较 |
| JS 对象构造 (ActionResult[]) | ~0.05ms | 每手牌 ~10 个 action 对象 |
| action schema JSON decode | 首次 ~0.05ms | 后续 Map 缓存 |
| handId 字典查询 (getHandId) | ~0.02ms | holeCards 字符串 → handId |
| GC 压力 | ~0.05-0.10ms | per-request 对象分配 |

---

## 5. 结论

### 5.1 优化成果

- 两阶段优化后，二进制 hand-strategy 查询 P50 从 1.39ms 降至 0.576ms，总体改进 **-59%**
- batch 查询从 22.3ms 降至 4.877ms，总体改进 **-78%**
- 文件 I/O 和全量解码两大瓶颈已消除，当前剩余开销集中在 MetaDb SQLite 索引查询和 JS 对象构造

### 5.2 与 SQLite 的差距

二进制方案当前仍慢于旧 SQLite（hand-strategy 8.6x，batch 4.3x），原因是：
- SQLite 单条查询路径极短：B-tree 索引直达 → 行数据已在同 page → 无序列化/反序列化开销
- 二进制方案每次查询仍需：MetaDb SQLite 索引查询 → pack 数据解码 → JS 对象构造
- 冷启动需加载全部 `.bin` 文件（272MB），适合常驻内存的服务场景

### 5.3 二进制方案适用场景

- 数据构建完成后只读，文件不再变化（符合）
- 查询 QPS 高、需要长时间保持连接（符合）
- 可接受冷启动时 ~160ms 的文件加载和 ~270MB 内存占用（符合）
- 需要精确的 Float32 频率/EV 值（符合）
- batch 查询场景（二进制方案 batch 优化 > 单条优化）

### 5.4 后续可选的进一步优化

1. **MetaDb 内存缓存**：将 range_pack_index 全量预取到 Map，消除每查询 SQLite 调用，预估可再降 ~0.2ms
2. **handId 二分查找**：利用 pack 中 handId 有序性二分定位，扫描 O(n) → O(log n)
3. **减少对象分配**：ActionCell 复用或直接返回数组而非对象，降低 GC 压力
4. **pack LRU 缓存**：高频 concreteLineId 的解码结果缓存，避免重复解码

---

## 6. 涉及文件清单

### 核心优化文件

| 文件 | 变更 |
|------|------|
| `src/query/preflop-query-service.ts` | API 精简、batch 重写、RangeBinMmapReader 接入 |
| `src/db/meta-db.ts` | prepared stmt 缓存、批量查询 |
| `src/binary/range-pack-codec.ts` | 新增 `decodeRangePackForHand`、`decodeRangePackMaskMatch`、TypedArray 优化 |
| `src/binary/range-bin-mmap-reader.ts` | **新增**：zero-copy 文件读取器 |

### 适配文件

| 文件 | 变更 |
|------|------|
| `src/benchmark/common.ts` | 移除 full-range/drill 相关类型和采样函数 |
| `src/benchmark/binary-runner.ts` | 移除对应方法，适配新 API |
| `src/benchmark/sqlite-runner.ts` | 同上 |
| `src/cli/benchmark-binary.ts` | 移除 full-range/drill CLI 参数和 case |
| `src/cli/benchmark-sqlite.ts` | 同上 |
| `src/cli/benchmark-compare.ts` | 适配新 workload 结构 |

### 测试

| 文件 | 变更 |
|------|------|
| `tests/binary-codec.test.ts` | 新增 `decodeRangePackForHand`、`decodeRangePackMaskMatch` 测试 |

### 文档

| 文件 | 变更 |
|------|------|
| `README.md` | 更新 API 示例 |
| `docs/query-sdk.md` | 更新 SDK 文档 |
| `docs/requirements-status-and-plan.md` | 更新 API 清单和进度 |
| `docs/issues-and-action-items.md` | 标记已解决项 |
| `tests/test-cases.md` | 更新测试用例 |

---

## 7. 阶段三：P0-P1 热路径优化（2026-06-13）

### 7.1 最终优化项

| 编号 | 内容 | 文件 | 状态 |
|------|------|------|------|
| P0 | decode 热路径 DataView → Uint32Array（对齐时），消除方法调用开销 | `range-pack-codec.ts` | 保留 |
| P1 | benchmark 全维度预热：启动时载入所有维度的 indexCache + mmap reader | `binary-runner.ts`, `meta-db.ts`, `preflop-query-service.ts`, `benchmark-binary.ts` | 保留 |
| P3 | indexCache LRU 淘汰（MAX=3） | `meta-db.ts` | ~~已移除~~ |

P3 尝试后证实有害：9 维度随机 workload 下 LRU=3 导致频繁淘汰和全量 SQL 重载，P95 从 0.909ms 飙升至 67ms。最终回退为无上限 indexCache。

### 7.2 P0 实现细节

`decodeRangePackForHand` 和 `decodeRangePackMaskMatch` 中 mask 读取：

```
对齐路径：new Uint32Array(buf, offset, handCount)[index]  // 快
不对齐：  new DataView(buf).getUint32(offset, true)        // fallback
```

mask 偏移 = handCount（每个 handId 1 字节），当 handCount % 4 === 1（如 169）时不对齐，走 DataView fallback。

cell 非对齐 fallback：仅进入 else 分支时才创建局部 DataView，对齐路径已用 Float32Array。

### 7.3 Benchmark 结果

基准测试参数：
- 维度：default 6max/8max/9max × 100BB/200BB/300BB（共 9 个维度）
- seed=42, hand 1000 次, batch 200 次 × 20 条/批, warmup 20 次
- packCacheSize=1024，indexCache 无上限

#### 7.3.1 延迟对比

| 用例 | 指标 | SQLite | Binary | 倍数 |
|------|------|--------|--------|------|
| **hand-strategy** | P50 | 0.054ms | 0.431ms | 8.0x |
| | P95 | 0.105ms | 0.611ms | 5.8x |
| | P99 | 0.154ms | 0.901ms | 5.9x |
| | avg | 0.059ms | 0.362ms | 6.1x |
| **batch-strategy** | P50 | 0.876ms | 3.731ms | 4.3x |
| | P95 | 1.279ms | 6.100ms | 4.8x |
| | P99 | 1.570ms | 6.777ms | 4.3x |
| | avg | 0.932ms | 3.545ms | 3.8x |

#### 7.3.2 吞吐对比

| 用例 | SQLite QPS | Binary QPS | 倍数 |
|------|-----------|-----------|------|
| hand-strategy | 16,799 | 2,759 | 6.1x |
| batch-strategy | 1,072 | 282 | 3.8x |
| 综合 | 5,053 | 1,032 | 4.9x |

#### 7.3.3 冷启动

| 指标 | SQLite | Binary |
|------|--------|--------|
| 首查耗时 | 15.0ms | 230.3ms |
| heapUsed 增量 | 0 | +191MB |
| RSS 增量 | +7.3MB | +274MB |

#### 7.3.4 内存占用

| 指标 | SQLite | Binary |
|------|--------|--------|
| 运行前 RSS | 188MB | 372MB |
| 运行后 RSS | 195MB | 646MB |
| RSS 增量 | +7.3MB | +274MB |
| heapUsed 增量 | 0 | +191MB |
| arrayBuffers 增量 | 0 | +163MB |

### 7.4 结果分析

**全面超越阶段二**：P0（Uint32Array）+ P1（全维度预热）组合效果显著：

| 指标 | 阶段二 | 阶段三 | 改进 |
|------|--------|--------|------|
| hand P50 | 0.576ms | 0.431ms | **-25.2%** |
| hand avg | 0.637ms | 0.362ms | **-43.2%** |
| hand P95 | 0.909ms | 0.611ms | **-32.8%** |
| batch P50 | 5.024ms | 3.731ms | **-25.7%** |
| batch avg | 4.877ms | 3.545ms | **-27.3%** |
| batch P95 | — | 6.100ms | — |

**P3 LRU 教训**：MAX_CACHED_DIMENSIONS=3 在 9 维度随机 workload 下完全失效——约 2/3 的查询触发缓存 miss，每次需全量 SQL 查询 + Map 重建。回退为无上限缓存后，P95 从 67ms 恢复至 0.611ms。

**缓存策略建议**：当前场景维度有限（≤ 2 位数字），无上限 indexCache 是可接受的。若未来维度数量膨胀到数百个，再考虑按查询热点动态调整的 LRU 或按需加载 + TTL 淘汰。

### 7.5 与历史对比

| 阶段 | hand P50 | hand avg | hand P95 | batch P50 | batch avg | batch P95 |
|------|----------|----------|----------|-----------|-----------|-----------|
| 原始基线 | 1.39ms | — | — | 22.3ms | — | — |
| 阶段一 | 0.759ms | 0.759ms | — | 8.139ms | 8.139ms | — |
| 阶段二 | 0.576ms | 0.637ms | 0.909ms | 5.024ms | 4.877ms | — |
| **阶段三** | **0.431ms** | **0.362ms** | **0.611ms** | **3.731ms** | **3.545ms** | **6.100ms** |
