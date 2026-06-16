# 项目问题清单与行动计划

> 生成日期：2026-06-12
> 基于项目全量代码审查结果

---

## P0 — 生产阻塞

### 1. 二进制查询性能严重劣于 SQLite ✅ **已解决**

**最终状态（2026-06-16）：** 通过三项优化（Flat TypedArray 批量传输 + 维度级 schema 预加载 + LRU handle 池），Scheme2 + Rust 的热路径延迟全面超越 SQLite：

| case | SQLite p50 | Scheme2 优化后 p50 | 提升 |
|------|-----------|-------------------|------|
| hand-strategy | 0.038 ms | 0.009 ms | 4.2x |
| batch-20 | 0.683 ms | 0.096 ms | 7.1x |
| batch-100 | 3.682 ms | 0.505 ms | 7.3x |
| 综合 QPS | 1,401 | 8,701 | 6.2x |

**历程**：经过 JS 版多轮优化（解码层、内存层、TypedArray）仍慢于 SQLite 3.3x → 引入 Rust napi-rs 热路径后反超 4.6x → 三项优化后进一步提升至 6.2x。详细过程见 `docs/notes/architecture-bottleneck-analysis.md`。

**Tradeoff**：冷启动从 SQLite 的 14ms 变为 1.21s（schema 预加载），内存从 +32MB 变为 +225MB（可通过 `maxOpenHandles` 控制）。适合预热场景。

---

## P1 — 质量与安全网

### 2. 测试覆盖率

**现状（2026-06-16）：** 已有 25 个 Bun 测试（3 个测试文件），覆盖 scheme2 查询服务、pack 编解码、文件格式等。测试通过 `bun test` 和 pre-commit hook 运行。

**仍缺失的测试：**

| 优先级 | 测试对象 | 说明 |
|---|---|---|
| 中 | 构建管线 smoke test | Scheme2 builder 的正确性 |
| 中 | 全量 CLI 参数解析 | 边界值、非法参数 |
| 低 | Benchmark 输出校验 | 确保 benchmark 不会静默失败 |

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
已完成 P0: 性能优化（Scheme2 + Rust + 三项优化，6.2x 快于 SQLite）
  ↓
P1: 测试补全（构建管线 smoke test、CLI 参数边界测试）
  ↓
P2: 代码去重 + 冷启动 OS cache 清除测试 + 错误风格统一
```
