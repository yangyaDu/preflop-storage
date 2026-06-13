# 存储架构对比调研：SQLite+fs vs mmap .idx+.bin

> 调研日期：2026-06-13
> 范围：`PreflopQueryService` 查询路径中的 pack 索引查找 + 二进制数据读取

---

## 1. 背景

当前项目将德州扑克翻前 GTO 策略数据从旧 SQLite 行存储格式转换为新的存储方案：

- `meta.db`：元数据（action_schemas、concrete_lines、drill_scenario_lines、range_pack_index）
- `ranges_*.bin`：策略荷载（按 `concrete_line_id` 分组编码的 range pack）

其中 `range_pack_index` 表记录了每个 pack 在 `.bin` 文件中的位置（offset + byte_length + checksum）。每次查询需要先从 SQLite 查索引，再从文件读数据，最后解码。

当前 benchmark 显示二进制方案查询性能严重劣于旧 SQLite：

| 用例 | SQLite P50 | 二进制 P50 | 差距 |
|---|---|---|---|
| hand-strategy | 0.044ms | 1.39ms | 31.6x |
| full-range | 0.39ms | 1.27ms | 3.3x |
| drill-random | 3.84ms | 84.2ms | 21.9x |
| batch-hand-strategy | 0.92ms | 22.3ms | 24.2x |

---

## 2. 两种架构方案

### 方案一（当前）：SQLite meta.db + node:fs 文件读取

```
查询 → meta.db SQLite 查 pack 位置 → fs.read(offset, len) 读 .bin 数据 → 解码 → 返回
```

**特点：**
- meta.db 是单一文件，包含全部元数据（action_schemas + drill_lines + concrete_lines + pack index）
- `.bin` 文件通过 `node:fs/promises` 的 `FileHandle.read()` 进行随机访问
- 每次读取分配新的 `Buffer`

### 方案二（提案）：mmap 索引文件 + mmap 数据文件

```
查询 → mmap .idx 二分查找 pack 位置 → mmap .bin slice 零拷贝取数据 → 解码 → 返回
```

**特点：**
- `meta.db` 仅保留元数据（action_schemas + drill_lines + concrete_lines），删除 `range_pack_index` 表
- 新增 `ranges_*.idx` 文件：定长记录的 pack 索引，按 `concrete_line_id` 升序
- `.bin` 文件通过 `Bun.mmap()` 映射，零拷贝访问

---

## 3. .idx 索引文件设计

### 记录格式（定长 22 字节）

| 字段 | 类型 | 偏移 | 字节 | 说明 |
|---|---|---|---|---|
| concrete_line_id | u32 LE | 0 | 4 | 主键，升序排列 |
| action_schema_id | u32 LE | 4 | 4 | 关联 action_schemas 表 |
| hand_count | u16 LE | 8 | 2 | pack 中的手牌数 |
| offset | u32 LE | 10 | 4 | 在 .bin 中的字节偏移 |
| byte_length | u32 LE | 14 | 4 | pack 的字节长度 |
| checksum | u32 LE | 18 | 4 | CRC32C |

**定长记录优势：** 已知 `totalCount`，直接用 `count = (fileSize - header16B) / 22` 计算，二分查找 O(log n)。

### 按维度生成（与 .bin 一一对应）

```
range-db/binary/
  ranges_default_6max_100BB.bin
  ranges_default_6max_100BB.idx
  ranges_default_6max_200BB.bin
  ranges_default_6max_200BB.idx
  ...
```

---

## 4. 各维度索引文件大小

| 维度 | pack 数 | .idx 大小 |
|---|---|---|
| default:6max:100BB | 3,737 | 82 KB |
| default:6max:200BB | 2,363 | 52 KB |
| default:6max:300BB | 1,816 | 40 KB |
| default:8max:100BB | 8,892 | 195 KB |
| default:8max:200BB | 5,454 | 120 KB |
| default:8max:300BB | 3,643 | 80 KB |
| default:9max:100BB | 197,087 | **4,331 KB** |
| default:9max:200BB | 203,028 | **4,462 KB** |
| default:9max:300BB | 95,114 | 2,091 KB |
| **合计** | **521,134** | **11.5 MB** |

---

## 5. 性能对比分析

### 5.1 单条 hand-strategy 查询耗时拆解

当前方案各环节耗时（P50 1.39ms 的构成）：

| 环节 | 耗时 | 占比 | 方案二改善 |
|---|---|---|---|
| MetaDb SQLite 查 pack 索引 | ~0.05ms | 3.6% | 改二分查找 mmap .idx，耗时相近 |
| fs.read() 系统调用 + buffer 分配 + 数据拷贝 | ~0.3ms | 21.6% | **改为 mmap slice，零拷贝，趋于 0** |
| decodeRangePack 全量解码 1690 cell | ~0.8ms | 57.6% | **按需解码，只解析目标手牌 ~10 cell，可降至 ~0.05ms** |
| JS 对象查找 + 组装结果 | ~0.02ms | 1.4% | 不变 |
| 其他开销（cache、调用栈） | ~0.22ms | 15.8% | 不变 |

**预估方案二 P50：~0.2ms**（相比 SQLite P50 0.044ms 仍有差距，但从 31.6x 劣化缩小到 4-5x）

### 5.2 文件读取路径对比

| | node:fs FileHandle.read() | Bun.mmap() |
|---|---|---|
| 内核态切换 | 每次 read() 一次系统调用 | 首次 mmap 时有 page fault，后续无 |
| 数据拷贝 | OS page cache → 用户态 Buffer | 无拷贝，直接读进程地址空间 |
| 内存分配 | 每次新分配 Buffer | 零分配（mmap 映射到虚拟地址） |
| GC 压力 | 有（频繁分配/释放 Buffer） | 无 |
| 文件增长 | 无需重新映射（offset 参数指定位置） | `.bin` 构建完后不再变化，天然适合 |
| 并发读 | 支持，但每个 read 串行 | 天然并行（只读共享映射） |

### 5.3 索引查找路径对比

| | SQLite prepared stmt | mmap .idx 二分查找 |
|---|---|---|
| 实现 | bun:sqlite `stmt.get(id)` | 二分查找 22 字节记录 |
| 时间复杂度 | O(log n) B-tree 遍历 | O(log n) 二分查找 |
| 真实开销 | 读取 1-3 个 4KB page + SQLite 字节码执行 + JS 对象构造 | ~18 次 4 字节比较（max 203K 条） |
| 内存占用 | SQLite page cache（按需） | 虚拟内存映射，OS 按需换页 |
| 依赖 | 需要 meta.db 文件 + bun:sqlite | 只需 .idx 文件 + Bun.mmap API |
| 错误恢复 | SQLite 提供 WAL/journal 保护 | 无内置保护，但构建完成后只读 |

> 注：两种查找方式的实际耗时差异在微秒级，均非性能瓶颈。

### 5.4 drill-random 和 batch 的批量优化

方案二的优势在 drill 和 batch 场景更明显：

**drill-random：** 当前需要对大量 concrete_line_id 逐一查 SQLite + 读文件。方案二下，`.idx` 二分查找可以同时用于所有 concrete_line，`.bin` 的 mmap 使得相邻 pack 的大范围读取变成零拷贝。

**batch：** 当前是 `for` 循环逐条调 `getHandStrategy`。方案二下：
```
1. 收集所有 concreteLineId
2. 对 .idx 批量二分查找 → 拿到全部 (offset, len)
3. .bin mmap 中并行 slice 取所有 pack 数据
4. 各 pack 按需解码
```

---

## 6. 元数据存储变化

### meta.db 瘦身

当前 `range_pack_index` 表占用 meta.db 的大部分空间（当前 meta.db = 87 MB，其中 pack index 表估计 60-70 MB）。移除后：

| 表 | 保留 | 估计大小 |
|---|---|---|
| action_schemas | 是 | ~2 MB |
| drill_scenario_lines_* | 是 | ~1 MB |
| concrete_lines_* | 是 | ~10 MB |
| build_info | 是 | <1 KB |
| range_pack_index_* | **删除** | ~60-70 MB |
| **meta.db 预估** | | **~15 MB**（从 87 MB） |

### .idx 文件的角色

移出 SQLite 的 pack index 以紧凑二进制格式独立存储：
- 11.5 MB（全部维度）
- mmap 映射，不进 JS 堆
- 零运行时内存开销（仅虚拟地址空间）

---

## 7. 架构对比总结

| 维度 | 方案一（SQLite+fs） | 方案二（mmap .idx+.bin） |
|---|---|---|
| **查询路径依赖** | meta.db + .bin 两个文件系统 | .idx + .bin 两个文件系统 |
| **索引查找** | SQLite prepared stmt | mmap 二分查找 |
| **数据读取** | fs.read() + Buffer 拷贝 | mmap 零拷贝 |
| **解码** | 全量解码（可改为按需） | 按需解码 |
| **meta.db 大小** | ~87 MB | ~15 MB |
| **新增文件** | 无 | 9 个 .idx 文件（合计 11.5 MB） |
| **JS 堆内存** | ~0（SQLite 在 native 层） | ~0（mmap 在 OS 层） |
| **依赖** | bun:sqlite + node:fs | Bun.mmap |
| **平台限制** | Node.js / Bun 均可 | 仅 Bun（mmap API） |
| **构建复杂度** | 不变 | + 同步写入 .idx |
| **数据一致性** | SQLite 事务保证 | 构建时事务保证，构建后只读无风险 |

---

## 8. 建议

**方案二比方案一更适合的场景：**
- 数据构建完成后只读（本项目符合）
- 查询 QPS 高、延迟敏感（本项目符合）
- 二进制文件不再增长（本项目符合）
- 使用 Bun 运行时（本项目符合）

**推荐方案二的实施路径：**

```
阶段1：按需解码 (decodeRangePackForHand)
  → 消除 57% 的解码开销
  → 不改变索引查询方式

阶段2：mmap .bin 替代 fs.read
  → 消除 21% 的文件读取开销
  → 需要 Bun.mmap API

阶段3：.idx 替代 range_pack_index
  → 消除 SQLite 依赖、meta.db 瘦身
  → 需要在构建管线中生成 .idx

阶段1 和 阶段2 可以并行开发。
```
