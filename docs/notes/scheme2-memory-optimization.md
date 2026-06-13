# 方案二内存优化：全量 mmap → 按需 fs.readSync

> 归档时间：2026-06-13
> 关联问题：P0-1「二进制查询性能严重劣于 SQLite」— 内存优化
> 优化项：P1 按需文件读取、P2 移除 concrete_lines 表、P3 并行预热

---

## 1. 背景

方案二上线后，9 维度 benchmark 的性能差距：

| 指标 | SQLite | 方案二（优化前） | 差距 |
|---|---|---|---|
| hand-strategy P50 | 0.052 ms | 0.303 ms | **5.8x** |
| 冷启动 | ~15 ms | 58 ms | **3.9x** |
| RSS 增加 | ~7 MB | ~215 MB | **30x** |
| Heap 增加 | 0 | ~214 MB | **∞** |

### 根本原因

`RangeBinMmapReader.open()` 调用 `Bun.file(path).bytes()` 将整个 `.bin` 文件加载到 JS `Uint8Array`。9 维度共 284 MB 全量驻留在 JS heap 中，触发：

- V8 大 ArrayBuffer 管理开销
- TLB/cache thrashing：跨 9 个不同 ArrayBuffer 区域随机访问
- 冷启动冗余：58ms 中大部分时间花在加载用不到的数据

### 为什么单维度反而比 SQLite 快 5.6x

单维度 (6max/100BB) .bin 仅 2.2 MB，可完全驻留 L3 cache，解码 2.8 μs 无内存惩罚。证明瓶颈不在解码器，在内存管理。

---

## 2. 优化方案与实施

### P1：将 .bin 文件读取从全量加载改为按需 fs.readSync

**新文件**：`src/binary/range-bin-file-reader.ts`

```
旧架构：open() → Bun.file().bytes() → 整文件 Uint8Array(284MB) → readRaw() 返回子视图
新架构：open() → openSync(fd) → readRaw(offset,len) → readSync(fd, buf, len, offset) → Buffer
```

阈值策略：
- `< 10 MB`：用 `RangeBinMmapReader`（全量加载，cache 友好）
- `>= 10 MB`：用 `RangeBinFileReader`（按需读取，OS cache 管理）

9 维度中各文件大小与 reader 选择：

| 维度 | .bin 大小 | Reader |
|---|---|---|
| 6max 100/200/300 | 1.4–2.1 MB | mmap |
| 8max 100/200/300 | 2.8–4.5 MB | mmap |
| 9max 100/200/300 | 61–104 MB | file reader |

**修改文件**：`src/scheme2/query/query-service.ts`
- `getBinReader()` 中先获取文件大小，按阈值选择 reader
- `binReaders` Map 类型改为 `BinReader` 联合类型

### P2：移除 meta.db 中的 concrete_lines 表

**问题**：`concrete_lines_*` 表 495K 行（77.6 MB），方案二查询服务从不读取。

**修改**：
- `src/scheme2/importer/build-binary-store.ts`：移除 `copyConcreteLines()` 函数、`insertConcreteLineByDimension` statements、相关 import
- 重建后 meta.db 从 74 MB → ~300 KB

### P3：并行维度预热

**修改**：`src/scheme2/benchmark/runner.ts` warmup 循环从 `for...of` + `await` 串行改为 `Promise.all` 并行。

---

## 3. 完整三方案对比

Benchmark 配置：9 维度，seed=42，200 hand + 100 batch，warmup=20

| 指标 | SQLite | 方案一 | 方案二（优化前） | 方案二（优化后） |
|---|---|---|---|---|
| **hand-strategy avg** | 0.092 ms | 0.346 ms | 0.303 ms | 0.333 ms |
| **hand-strategy QPS** | 10,849 | 2,891 | 3,300 | 3,001 |
| **batch-hand-strategy** | 1.105 ms | 4.258 ms | N/A | 4.013 ms |
| **batch QPS** | 905 | 235 | N/A | 249 |
| **总耗时（300 iter）** | 128.97 ms | 494.99 ms | N/A | 467.93 ms |
| **冷启动** | 17.80 ms | 359.52 ms | 58 ms | **17.39 ms** |
| **RSS 增加** | 4.55 MB | 230.79 MB | ~215 MB | **52.34 MB** |
| **Heap 增加** | 0 B | 149.79 MB | ~214 MB | **23.10 MB** |

---

## 4. 优化效果总结

### vs 方案二优化前

| 指标 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| 冷启动 | 58 ms | 17.39 ms | **3.3x** |
| RSS 增加 | ~215 MB | 52.34 MB | **4.1x** |
| Heap 增加 | ~214 MB | 23.10 MB | **9.3x** |
| hand-strategy avg | 0.303 ms | 0.333 ms | -10%（轻微倒退） |

### vs 方案一

| 指标 | 方案一 | 方案二（优化后） | 提升 |
|---|---|---|---|
| 冷启动 | 359.52 ms | 17.39 ms | **20.7x** |
| RSS 增加 | 230.79 MB | 52.34 MB | **4.4x** |
| Heap 增加 | 149.79 MB | 23.10 MB | **6.5x** |

### vs SQLite

| 指标 | SQLite | 方案二（优化后） | 差距 |
|---|---|---|---|
| hand-strategy | 0.092 ms | 0.333 ms | **3.6x** |
| 冷启动 | 17.80 ms | 17.39 ms | **持平** |

---

## 5. 残余差距分析

### 延迟仍慢 3.6x 的原因

查询延迟 0.333ms（SQLite 0.092ms）的构成：

| 环节 | 估算耗时 | 说明 |
|---|---|---|
| .idx 二分查找 | ~5 μs | mmap + O(log n)，记录数 ~100K |
| .bin 数据读取 | ~10–40 μs | readSync 系统调用 + Buffer 分配，OS cache 命中时偏低 |
| decodeRangePackForHandDirect | ~3 μs | 零分配 TypedArray 解码 |
| JS 对象构造（ActionResult[]） | ~20–50 μs | 每个 hand 构造 ~10 个 ActionResult 对象 |
| JIT/V8 GC 开销 | ~50–200 μs | 跨维度随机查询触发 V8 多态 IC 失效 |

SQLite 的延迟优势来自：
1. 无对象分配——结果集直接映射到 C 结构
2. B-tree 内联查询——索引和数据在同一 page 中
3. 无 JS 运行时开销

### 可优化的剩余方向

1. **Buffer 对象池**：复用 readSync 用的 Buffer，避免每次查询 `Buffer.alloc()`
2. **ActionResult 对象复用**：用 TypedArray 中间格式取代对象数组
3. **V8 内联优化**：减少跨维度多态，统一热路径
4. **批量预读**：`readahead` / `fadvise` 提示 OS 提前加载热点区域

---

## 6. 修改文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/binary/range-bin-file-reader.ts` | 新建 | 按需 fs.readSync 读取器 |
| `src/scheme2/query/query-service.ts` | 修改 | 按文件大小选择 reader 类型 |
| `src/scheme2/importer/build-binary-store.ts` | 修改 | 移除 concrete_lines 复制逻辑 |
| `src/scheme2/benchmark/runner.ts` | 修改 | 并行预热 |

## 7. 不变项

- `src/binary/range-bin-mmap-reader.ts` — 保留，小文件继续使用
- `src/scheme2/idx/` — .idx 文件小，全量 mmap 合理
- `src/binary/range-pack-codec.ts` — 解码器不变
- `src/benchmark/common.ts` — 测量框架不变
