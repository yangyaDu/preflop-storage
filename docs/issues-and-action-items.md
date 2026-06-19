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

**现状（2026-06-20）：** 已有 119 个 Bun 测试，覆盖 scheme2 查询服务、构建续跑/manifest、verify、自检/交叉校验、pack 编解码、文件格式、CLI 参数解析边界值、native build script smoke test、benchmark 输出校验、Float32 bit-exact 精度校验等。测试通过 `bun test` 和 pre-commit hook 运行。

**仍缺失的测试：**

| 优先级 | 测试对象 | 说明 |
|---|---|---|
| 低 | OS 冷启动 benchmark 自动化测试 | 平台相关，需避免拖慢常规测试 |

**已补充：**
- ✅ CLI 参数解析边界测试（`tests/cli-args.test.ts`，50 个用例，覆盖 parseCliArgs/getStringArg/getNumberArg/getBooleanArg/getNumberListArg/getRepeatedStringArgs）
- ✅ Scheme2 构建管线测试（`tests/scheme2-build.test.ts`，覆盖 build、resume、overwrite、manifest、stats、查询错误语义）
- ✅ Native build script smoke test（`tests/native-build-script.test.ts`，覆盖 target 列表、dry-run、`--` 分隔符和不支持 target）
- ✅ Benchmark 输出校验（`tests/benchmark-output.test.ts`，覆盖 Scheme2 benchmark JSON/Markdown 输出、`--verify-results` note、错误计数和非 0 退出码）

---

## P2 — 维护性与技术债务

### 3. Husky v10 兼容性 ✅ **已解决**

**最终状态（2026-06-16）：** 已通过 `npx husky init` 重新初始化 hook 内部脚手架，pre-commit 为 v9/v10 兼容格式（直接 shell 命令，不 sourcing husky.sh）。`_/husky.sh` 废弃 shim 仅对旧格式 hook 触发，不影响当前项目。

### 4. 代码重复 ✅ **已解决**

**最终状态（2026-06-16）：**

| 函数 | 原出现次数 | 新位置 | 说明 |
|---|---|---|---|
| `sum(values: number[])` | 4 | `src/utils/math.ts` | 标准 reduce 求和 |
| `filterDimensions()` | 3（实为 4，含 scheme2） | `src/utils/dimension.ts` | 统一为 `DimensionSpec[] \| null \| undefined` 签名 |
| `parseDimension()` | 2（实为 3，含 scheme2） | `src/utils/dimension.ts` | 返回 `DimensionSpec` 类型 |

所有 9 个原文件中的本地定义已移除，改为从 `src/utils/` 导入。

### 5. Float32 精度差异 ✅ **已解决 V1**

**最终状态（2026-06-20）：** 已将固定容差策略升级为 Float32 bit-exact 策略。

新的硬标准是：`decoded` 必须等于 `Math.fround(source)`，并且 Float32 bit pattern 一致。这样只允许 IEEE754 Float32 正确舍入带来的不可避免量化损失，不允许编码、解码、字节序、Rust/JS 转换或验证逻辑引入额外损失。

已补充：

- `docs/float32-precision-spec.md`：Float32 bit-exact 精度策略
- `src/precision/float32.ts`：Float32 bits、round-trip 校验、量化误差统计
- `src/scheme2/verify/checks/source-cross.ts`：cross verify 使用 bit-exact 校验，并输出 `precision` 统计
- `tests/float32-precision.test.ts`：精度工具测试
- `tests/scheme2-verify.test.ts`：覆盖“旧容差会放过但 Float32 bit 不一致必须失败”的边界 case

历史观测值仍保留为报告参考：全量验证曾发现 2380 万条记录中约 70 条 `hand_ev` 固定容差边界 case，最大量化误差约 `0.000015`，集中在 `default:9max:300BB AA/raise` 场景。

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
已完成 P1: CLI 参数边界测试 + 代码去重 + Husky v10 兼容性
  ↓
剩余 P2: OS 冷启动 benchmark
```
