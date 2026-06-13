# 项目问题清单与行动计划

> 生成日期：2026-06-12
> 基于项目全量代码审查结果

---

## P0 — 生产阻塞

### 1. 二进制查询性能严重劣于 SQLite

**现状：** 二进制存储方案的单手策略 P95 延迟为 3.15ms，而旧 SQLite 方案仅为 0.148ms（21x 慢）。drill-random 查询差距更大：二进制 1.57s vs SQLite 65.75ms（24x 慢）。

**已实施优化（2026-06-13）：**
- MetaDb 引入 per-dimension prepared statement 缓存，消除 SQL 编译开销
- 新增 `decodeRangePackForHand()` 按需解码（只解析目标手牌 ~10 cell，而非全量 1690 cell）
- 新增 `decodeRangePackMaskMatch()` 掩码匹配（不解析 cell 数据段）
- `getHandStrategiesBatch` 重写：按 concreteLineId 分组 + 批量 SQL 查询 + 并行读取 pack
- 删除 `getFullRange`（合并到 `getHandsByAction`）、`getScenarioHandStrategies` 等冗余 API
- 删除 `getHandStrategyOrThrow`（一行包装，调用方自行 `?? throw`）

**影响：** 按需解码将 pack 读取的码本分配从 1690 cells 降至 ~10 cells，配合 prepared stmt 缓存和 batch 并行化，大幅降低查询延迟。需重新跑 benchmark 验证提升幅度。

**建议方向：**
1. ~~使用真实工作负载做 profile，定位瓶颈在 I/O 还是计算~~（已完成：确定为全量解码 + SQL 编译）
2. ~~`MetaDb` 引入连接池或长连接~~（已完成：prepared statement 缓存）
3. 考虑 `mmap` / `fadvise` 对二进制文件的适用性
4. 补充 OS 冷启动测试（清除 page cache 后测试）

---

## P1 — 质量与安全网

### 2. 测试覆盖率严重不足

**现状：** 整个项目只有 5 个单元测试（`tests/binary-codec.test.ts`），仅覆盖 CRC、文件头、action schema、range pack 的编解码往返。

**缺失的测试（按优先级）：**

| 优先级 | 测试对象 | 说明 |
|---|---|---|
| 高 | `PreflopQueryService` | 核心查询 API，包含错误码路径 |
| 高 | `MetaDb` | 元数据库查询方法 |
| 高 | `build-binary-store.ts` | 构建管线 smoke test |
| 中 | 全量 CLI 参数解析 | 边界值、非法参数 |
| 中 | 批处理错误处理 | `getHandStrategiesBatch()` 的 per-item error |
| 低 | Benchmark 输出校验 | 确保 benchmark 不会静默失败 |

`tests/test-cases.md` 中列了 15 个测试用例，目前全部为手动测试，未自动化。

**影响：** 性能优化、重构等任何修改都无法安全进行，回归风险极高。

---

## P2 — 维护性与技术债务

### 3. Husky v10 兼容性

**现状：** `.husky/_/husky.sh` 中的当前 deprecation 模式**将在 husky v10.0.0 中彻底失效**，届时 pre-commit hook 直接报错，阻断所有提交。

**修复方式：** 按 husky v10 新范式重新初始化 hook（`npx husky init`）。

**当前 pre-commit hook 内容：**
```
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"
bun run typecheck
bun run lint
```

注意：当前 hook 不运行测试（只运行 typecheck + lint），`bun run check` 命令则在 CI/手动运行时执行完整的三项（typecheck + lint + test）。

### 4. 代码重复

以下函数在多文件中原样拷贝，无共享模块：

| 函数 | 出现位置 | 次数 |
|---|---|---|
| `sum(values: number[])` | `benchmark/common.ts`、`cli/analyze-sqlite.ts`、`cli/analyze-binary.ts`、`cli/verify-binary.ts` | 4 |
| `filterDimensions()` | `benchmark/common.ts`、`importer/build-binary-store.ts`、`cli/verify-binary.ts` | 3 |
| `parseDimension()` | `cli/build-binary.ts`、`cli/verify-binary.ts` | 2 |

**建议：** 提取到 `src/utils/stats.ts` 和 `src/utils/dimension.ts`，消除维护不一致的风险。

### 5. Float32 精度差异

**现状：** 全量验证发现 2380 万条记录中有 70 条 `hand_ev` 精度误差（最大差 0.000015），发生在 `default:9max:300BB AA/raise` 场景。

**影响：** 虽已通过验证（在容差范围内），但说明浮点数往返编码存在边界 case。

**建议：**
1. 建立生产数据的浮点数容差规范文档
2. 在验证流程中增加可配置的容差阈值参数
3. 对超出容差的记录自动生成差异报告

### 6. OS 冷启动测试缺失

**现状：** 所有 benchmark 数据均未清除 OS page cache，无法区分 I/O 开销和计算开销。

**建议：** 添加冷启动 benchmark variant（运行前清除 page cache），与热启动数据对比。

### 7. 错误处理风格不一致

**现状：** 项目中同时使用原始 `new Error()`（在二进制编解码层）和 `PreflopQueryError`（在查询服务层），存在混用风险。

**待办：** 审查各层错误类型策略，确定是否需要统一错误类层次。

---

## 建议执行顺序

```
P0: 性能回归修复（需先 profile）
  ↓
P1: 测试补全（优先 PreflopQueryService、MetaDb、构建管线）
  ↓
P2: Husky 迁移 + 消除代码重复 + 精度规范 + 冷启动测试 + 错误风格审查
```

性能优化和测试补全可以部分并行，但推荐先补关键测试再做性能改动，以确保不引入回归。
