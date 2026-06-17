# Preflop Storage Benchmark 分析与优化建议报告

本报告针对最近生成的 SQLite 和 二进制（Scheme2）基准测试结果进行深度对比与分析，解释两者的性能特征差异，并指出下一步的核心优化方向。

---

## 1. 基准测试数据总览

结合最新执行的 `1,000` 次单手牌迭代与 `200` 次批量迭代的数据，汇总对比如下：

| 测试指标 | SQLite 引擎 | 二进制 Scheme2 (Random) | 二进制 Scheme2 (Abstract-Local) | Scheme2 性能对比 (vs SQLite) |
| :--- | :--- | :--- | :--- | :--- |
| **冷启动首查** | **14.71 ms** (预热) | **73.90 ms** (预热) | **63.17 ms** (预热) | 慢约 4-5 倍 |
| **冷启动首查 (无预热)** | ~15 ms | **3.53 ms** | - | **快 4.2 倍** |
| **单手牌查询 (Avg)** | **0.200 ms** (Local) <br> **0.048 ms** (Random) | **0.150 ms** | **0.018 ms** | **Local 下快 11.1 倍** <br> Random 下慢 3.1 倍 |
| **单手牌查询 (p50)** | **0.212 ms** (Local) <br> **0.039 ms** (Random) | **0.189 ms** | **0.012 ms** | **Local 下快 17.6 倍** <br> Random 下慢 4.8 倍 |
| **单手牌查询 QPS** | ~5,011 (Local) <br> ~20,733 (Random) | 6,665 | **56,312** | **Local 下提升 11.2x** |
| **批量查询 (Size 100, Avg)** | **3.467 ms** (Local) <br> **4.040 ms** (Random) | **1.092 ms** | **0.445 ms** | **Local 下快 7.8 倍** <br> **Random 下快 3.7 倍** |
| **批量查询 (Size 100) QPS** | 288 (Local) <br> 247 (Random) | 915 | **2,249** | **Local 下提升 7.8x** |
| **内存增量 (RSS Delta)** | ~31.76 MB | ~205.57 MB | ~105.88 MB | 内存占用高 3.3-6.5 倍 |

> [!NOTE]
> - SQLite 数据基于 [reports/benchmark-sqlite.md](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/reports/benchmark-sqlite.md)（Abstract-Local 模式和 Random 历史数据）。
> - 二进制 Scheme2 数据基于 [reports/benchmark-scheme2.md](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/reports/benchmark-scheme2.md)。

---

## 2. 关键性能表现解释

### 2.1 为什么 Scheme2 在 Local（局部性高）模式下表现极其强悍？
在 `abstract-local` 局部性高模式下，单手牌查询延迟降到了惊人的 **0.018 ms（QPS > 5.6万）**。
- **内存页热缓存（OS Page Cache）**：`abstract-local` 模式下，连续的查询属于同一个或相邻的抽象路径（abstract line），它们在二进制文件 `.bin` 和 `.idx` 中所占用的虚拟内存页是完全重合或相邻的。此时通过 `mmap` 读取数据不需要任何磁盘 I/O，全部在 CPU 缓存和物理内存中完成。
- **无 SQL 解析与引擎开销**：SQLite 即使在数据完全被其内置 Cache 缓存的情况下，仍然需要进行 SQL 词法解析、编译执行计划、B-Tree 索引检索、虚拟数据库机（VDBE）运行以及将行数据反序列化为 JS 对象。而 [Scheme2QueryService](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/src/scheme2/query/query-service.ts) 在 Rust 层的 [lib.rs](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/native-addon/src/lib.rs) 实现了纯内存的 `u8` 二分查找和紧凑结构位解码，开销极其微小。

### 2.2 为什么在 Random 模式下 SQLite 单次查询反超 Scheme2？
在完全随机查询（Random 模式）下，SQLite 单次查询平均只需 **0.048 ms**，而 Scheme2 需要 **0.150 ms**。
- **mmap 缺页中断（Page Fault）**：因为 preflop 数据很大（总共 9 个维度，约 350MB 二进制数据），在 Random 模式下，每一次查询都会命中文件的完全不同位置。由于我们使用 `mmap` 对文件进行惰性加载，当访问未载入物理内存的地址时，操作系统会触发 **缺页中断 (Page Fault)**，强行阻塞当前线程去读取磁盘。由于 Node.js/Bun 的 JS 执行是单线程的，这种同步阻塞会直接拉低主线程的查询延迟。
- **SQLite 自带页缓存与索引优化**：`bun:sqlite` 基于 C++ 编写，且自带高效的数据页预读和缓存机制，在离散的随机读取上表现出极强的平稳性。

### 2.3 为什么 Batch（批量）查询下 Scheme2 全面碾压 SQLite？
在 `batch-size-100` 下，即使是 Random 模式，Scheme2 也比 SQLite 快了 3.7 倍；而在 Local 模式下更是快了 7.8 倍。
- **FFI Boundary 摊薄**：在 JS 中，通过循环查询 SQLite 意味着每次循环都要跨越一次 JS-C++ 边界（100次循环就是100次 FFI 边界跨越）。而 Scheme2 的 `getHandStrategiesBatchSync` 只需要跨越 **一次** JS-Rust 边界，把包含 100 个请求的数组一次性传递给 Rust 的 [query_batch](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/native-addon/src/lib.rs#L86-L96)，并在 Rust 的原生多态循环中完成所有二分查找，极大减少了跨语言调用的管理开销。
- **校验去重优化**：最近新增的批查询去重机制，过滤掉了无效手牌和非法请求，进一步缩短了实际交给 Rust 引擎执行的工作量。

### 2.4 冷启动与预热成本分析
- **预热动作 Schema 成本高**：如果开启了 `--prewarm-action-schemas`，冷启动会飙升到 70ms 左右。这是因为我们需要去 SQLite `meta.db` 中一次性查出所有的 `action_schemas`（总计 19,404 条）并加载到 Map 缓存。
- **无预热极速冷启动**：如果关闭预热，Scheme2 的冷启动首查只需要 **3.53 ms**，而 SQLite 需要 15 ms。这证明了 `mmap` 的秒级建立能力。

---

## 3. 下一步优化方案

为了进一步抹平 Random 模式下单查询的差距，并优化冷启动和内存表现，建议在接下来的阶段进行以下几项核心优化：

### 3.1 引入异步/线程池缺页预读 (Avoid Blocking JS Main Thread)
- **问题**：在随机 workload 下，由于缺页中断在主线程同步发生，阻塞了事件循环。
- **优化方案**：
  - 在 Rust Addon 层提供**异步版本**的查询接口（例如基于 N-API 的 `ThreadsafeFunction` 或 `AsyncTask`）。
  - 在 Rust 内部利用线程池（如 `rayon` 或原生线程）执行二分查找与 `mmap` 数据加载。这样，当操作系统执行磁盘 I/O（缺页预读）时，不会阻塞 Bun 的主线程，使整体并发吞吐量成倍上升。

### 3.2 优化 Action Schema 的加载策略 (Lazy Loading + LRU Cache)
- **问题**：启动时一次性预热 1.9 万个 Action Schema 导致冷启动变慢（70ms），但不预热又会在热查询中遭遇 SQLite `meta.db` 的查询瓶颈。
- **优化方案**：
  - **按维度延迟加载**：不需要在最开始载入所有 Schema，而是在 `prewarmDimension` 时只载入该维度关联的 Schema。
  - **二级缓存/零拷贝存储**：将 action schemas 同样打包进只读的二进制文件（如 `schemas.bin`）中，采用 `mmap` 进行查找，彻底免除启动时对 SQLite `meta.db` 的查询依赖。

### 3.3 减少 FFI 传输中的 JS 对象创建开销 (Zero-Copy Serialization)
- **问题**：当 Batch 数量为 100 时，Rust 的 `query_batch` 返回一个包含 100 个 `PackDecodeResult` 的大数组，每个 result 内部又有嵌套的 `cells` 数组与对象。这需要 N-API 在 V8 堆上频繁创建成百上千个小 JavaScript 对象，GC 压力和内存转换耗时明显。
- **优化方案**：
  - **扁平化 TypedArray 传输**：Rust 直接向 JS 返回一块扁平的 `Int32Array` / `Float32Array`（例如：`[action_count, freq1, ev1, freq2, ev2, ...]`）。JS 侧通过轻量级偏移量读取，避免创建中间嵌套对象。
  - 这种零拷贝传输通常能使批量查询性能再提升 **30% - 50%**。

### 3.4 细粒度 `mmap` 内存管理与释放 (Handle Pool & LRU)
- **问题**：随着不同维度的查询被预热，9 个维度的 `DimensionHandle` 会全部保持开启状态，占用较多的虚拟内存和物理内存（RSS Delta 达到 200MB+）。
- **优化方案**：
  - 在 [Scheme2QueryService](file:///c:/Users/Duyang/Desktop/elysia_project/preflop-storage/src/scheme2/query/query-service.ts) 中引入一个 **LRU Dimension Handle Pool**（比如最大容纳 3-4 个维度连接）。
  - 当维度不活跃时，显式释放 Handle，依靠 Rust 的 `Drop` 机制解除 `mmap` 映射并关闭文件描述符，将 RSS 内存占用控制在健康范围。

---

## 4. 结论

- **对于高局部性的 poker tree solver / solver traversal 场景**，Scheme2 二进制设计已经取得了绝对的胜利（性能是 SQLite 的 **11 倍** 以上）。
- **对于大规模批量分析场景**，即使存在局部的 page faults，二进制方案由于其单次 FFI 调用带来的摊薄效应，依然比 SQLite 快了 **3-7 倍**。
- **如果确实存在极度离散、完全随机的单手牌实时查询需求**，可以通过 **3.1 引入 Rust 异步线程池** 或 **3.2 惰性预热** 来优化，从而超越 SQLite 的表现。
