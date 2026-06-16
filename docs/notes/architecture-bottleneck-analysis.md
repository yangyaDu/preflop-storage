# 架构瓶颈分析与方案选择记录

> **历史文档**：本文档记录了 2026-06-13 从方案一到方案二的架构迁移决策。
> 当前最新性能数据见 `docs/requirements-status-and-plan.md` 第 12 节。
>
> 归档时间：2026-06-13
> 决策：从方案一（SQLite meta.db + fs 读 .bin）迁移到方案二（mmap .idx + mmap .bin）

---

## 1. 背景

项目已完成方向 C 的第一版工程原型（SQLite meta.db 存元数据/索引 + .bin 存策略荷载）。经过三轮性能优化（按需解码 → zero-copy mmap → TypedArray + 全维度预热），hand-strategy P50 从原始 1.39ms 降至 0.431ms（-69%）。但核心指标仍严重落后旧 SQLite。

## 2. 当前性能差距（第三轮优化后）

| 指标 | SQLite | 方案一 | 差距 |
|---|---|---|---|
| hand-strategy P50 | 0.054ms | 0.431ms | **8.0x** |
| hand-strategy P95 | 0.105ms | 0.611ms | **5.8x** |
| batch-strategy P50 | 0.876ms | 3.731ms | **4.3x** |
| 内存增量 | +7.3MB | +274MB | **37.5x** |
| 冷启动 | 15.0ms | 230.3ms | **15.3x** |

## 3. 瓶颈根因

方案一的每次查询需要两次查找：SQLite 索引查询 + .bin 文件读取 + 解码。SQLite 原生 B-tree 在同个 page 内完成索引+数据读取，无额外寻址开销。

剩余瓶颈（profile 数据）：
1. `TypedArray.subarray()` 内存切片 ~0.3-0.35ms
2. MetaDb SQLite 索引查询 ~0.15-0.25ms
3. JS 对象构造 + GC 压力
4. meta.db 87MB（其中 range_pack_index 占 60-70MB）

## 4. 架构级优化方案（方案二）

### 设计

```
查询 → mmap .idx 二分查找 pack 位置 → mmap .bin slice 零拷贝取数据 → 解码 → 返回
```

- `meta.db` 仅保留元数据（action_schemas + drill_lines + concrete_lines），删除 `range_pack_index` 表
- 新增 `ranges_*.idx` 文件：定长 22 字节记录，按 `concrete_line_id` 升序
- `.bin` 文件通过 `Bun.file().bytes()` 零拷贝访问（已有 `RangeBinMmapReader`）

### .idx 记录格式（定长 22 字节）

| 字段 | 类型 | 偏移 | 字节 |
|---|---|---|---|
| concrete_line_id | u32 LE | 0 | 4 |
| action_schema_id | u32 LE | 4 | 4 |
| hand_count | u16 LE | 8 | 2 |
| offset | u32 LE | 10 | 4 |
| byte_length | u32 LE | 14 | 4 |
| checksum | u32 LE | 18 | 4 |

### 文件映射

```
range-db/binary/
  ranges_default_6max_100BB.bin
  ranges_default_6max_100BB.idx   ← 新增
  ranges_default_6max_200BB.bin
  ranges_default_6max_200BB.idx   ← 新增
  ...
```

### 预估收益

- hand-strategy P50：0.431ms → **~0.2ms**（主要消除 subarray + SQLite 查询开销）
- meta.db：87MB → **~15MB**
- .idx 文件总大小：**11.5MB**（mmap 不进 JS 堆）
- 消除 SQLite indexCache 和 prepared statement 的 JS 堆开销

## 5. 决定

采纳方案二。实施路径：

1. 构建阶段：生成 .idx 文件 + 移除 range_pack_index 表
2. 查询阶段：RangeIdxReader（mmap + 二分查找）替代 MetaDb 索引查询
3. 清理 MetaDb 不再需要的字段和缓存逻辑
4. Benchmark 更新

## 6. 相关文档

- `storage-architecture-comparison.md`：方案一/二详细对比
- `issues-and-action-items.md`：P0/P1/P2 问题清单
- `requirements-status-and-plan.md`：需求完成度矩阵
