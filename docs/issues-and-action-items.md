# 项目问题清单与行动计划

> 生成日期：2026-06-12
> 更新日期：2026-06-20（brooks-health 四维度代码健康审查 + OS 冷启动 Benchmark V2）
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

**现状（2026-06-20）：** 已有 122 个 Bun 测试，覆盖 scheme2 查询服务、构建续跑/manifest、verify、自检/交叉校验、pack 编解码、文件格式、CLI 参数解析边界值、native build script smoke test、benchmark 输出校验、Float32 bit-exact 精度校验、OS 冷启动 benchmark 输出等。测试通过 `bun test` 和 pre-commit hook 运行。

**已补充：**
- ✅ CLI 参数解析边界测试（`tests/cli-args.test.ts`，50 个用例，覆盖 parseCliArgs/getStringArg/getNumberArg/getBooleanArg/getNumberListArg/getRepeatedStringArgs）
- ✅ Scheme2 构建管线测试（`tests/scheme2-build.test.ts`，覆盖 build、resume、overwrite、manifest、stats、查询错误语义）
- ✅ Native build script smoke test（`tests/native-build-script.test.ts`，覆盖 target 列表、dry-run、`--` 分隔符和不支持 target）
- ✅ Benchmark 输出校验（`tests/benchmark-output.test.ts`，覆盖 Scheme2 benchmark JSON/Markdown 输出、`--verify-results` note、错误计数和非 0 退出码）
- ✅ OS 冷启动 benchmark 输出校验（`tests/cold-start-benchmark.test.ts`，覆盖默认全成功维度、维度过滤、runs alias、固定查询口径、JSON/Markdown 输出、**失败隔离**：删除 `.bin` 后验证 latency 聚合仅使用成功 run）

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

### 6. OS 冷启动 Benchmark ✅ **已解决 V2**

**最终状态（2026-06-20）：** 已新增 `bun run benchmark:scheme2:cold` 和自动化测试（3 个用例）。

V1 基础能力：

- `src/scheme2/cli/benchmark-cold-start.ts`：父进程入口，默认读取 manifest 全部成功维度；生产产物应覆盖 9 个维度。
- `src/scheme2/cli/benchmark-cold-worker.ts`：单次 fresh process worker。
- `tests/cold-start-benchmark.test.ts`：2 维度 fixture 测试。
- `package.json`：`benchmark:scheme2:cold`。

V2 改进（grilling review 后）：

- 重命名 `openAndFirstQueryMs` → `storeOpenAndFirstQueryMs`（三层口径：processElapsed / workerTotal / storeOpenAndFirstQuery）
- 失败 run 隔离：仅成功 run 参与 latency 聚合；新增 `successCount`、`failures[]` 字段；`--fail-fast`、`--max-errors-per-dimension` 韧性控制
- Phase accounting：校验 `phaseSumMs - workerTotalMs`，输出 `unaccountedMs` / `unaccountedRatio`
- `os-best-effort` 非零确定性 filler（XOR 0xAA），语义降级为 cache perturbation
- `--query-policy first|fixed`，roadmap：round-robin、random、stratified
- 父进程 RSS 采样（`aggregate.parentRssSamples`）
- 新增失败隔离测试：删除 `.bin` 文件后验证该维度 latency 聚合为空、健康维度不受影响

推荐 9 维度运行：

```powershell
bun run benchmark:scheme2:cold --source range-db/range.db --dir range-db/binary-scheme2 --runs 10 --query-policy fixed --concrete-line-id 1 --hand AA --mode process-cold
```

当前本机基线（2026-06-20）：9 个维度、90 runs、0 errors；aggregate store open+first-query p50 / p95 为 `340.36 ms / 2822.17 ms`，aggregate process elapsed p50 / p95 为 `518.28 ms / 3023.35 ms`。阶段拆分显示主要瓶颈是 `Dimension prewarm`，p50 / p95 为 `338.85 ms / 2820.40 ms`；首查 decode p50 / p95 仅 `0.46 ms / 0.70 ms`。Phase accounting 一致性：90 runs 最大 `unaccountedMs` 0.185ms。报告见 `reports/benchmark-cold-start.md`。

### 7. 错误处理风格不一致

**现状：** 项目中同时使用原始 `new Error()`（在二进制编解码层）和 `PreflopQueryError`（在查询服务层），存在混用风险。

**具体表现：**

| 文件 | 位置 | 问题 |
|------|------|------|
| `src/scheme1/importer/build-binary-store.ts` | 3 处 | `new Error("Output meta DB already exists...")` 等 |
| `src/scheme1/cli/analyze-sqlite.ts` | 3 处 | 表名解析失败、PRAGMA 返回值校验使用 `new Error()` |
| `src/scheme1/cli/benchmark-compare.ts` | 2 处 | 报告引擎类型校验使用 `new Error()` |
| `src/scheme1/cli/verify-binary.ts` | 3 处 | 数据缺失、action schema 缺失、参数错误使用 `new Error()` |

Scheme2 侧已统一为 `PreflopStoreError` / `PreflopQueryError`，scheme1 侧仍为原始 `Error`，调用方无法按错误码路由处理。

**待办：** 将 scheme1 的 11 处 `new Error()` 迁移到 `PreflopStoreError`。

### 8. build-binary-store.ts 职责单石

**现状（2026-06-20）：** `src/scheme2/importer/build-binary-store.ts` 共 802 行、20+ 个函数，承担 6 项以上不同职责：

| 职责 | 函数 | 行数估计 |
|------|------|---------|
| 维度发现与验证 | `uniqueStrategies()` + `prepareBuildStatements()` | ~100 行 |
| SQLite meta.db 写入 | `copyDrillScenarioLines()` + `copyConcreteLines()` + `getOrInsertActionSchema()` | ~180 行 |
| 二进制 pack 编码与写入 | `buildDimension()` 内联 pack 编码逻辑 | ~120 行 |
| 文件 I/O 与清理 | `cleanupPreviousOutput()` + `removeFileWithRetry()` + `computeFileSha256()` | ~80 行 |
| 构建编排（--resume/--overwrite） | `readBuildManifest()` + `assertResumeSourceChecksum()` + `collectCompletedManifestStats()` | ~100 行 |
| Report 渲染 | `renderBuildReportMarkdown()` + `formatNum()` + `formatBytes()` | ~80 行 |

**风险：** 单文件承载过多职责，修改任一职责时存在意外影响其他逻辑的风险；report 渲染与构建逻辑耦合，无法独立测试。

**建议：** 拆分为 `build-orchestrator.ts`（编排） + `dimension-builder.ts`（单维度构建） + `report-renderer.ts`（报表渲染），参考 Broker-Provider 模式。

### 9. Scheme1 / Scheme2 CLI 重复

**现状：** CLI 入口有 8 个 scheme1 脚本 + 6 个 scheme2 脚本，重叠模式明显：

| 功能 | Scheme1 | Scheme2 |
|------|---------|---------|
| 构建 | `src/scheme1/cli/build-binary.ts` | `src/scheme2/cli/build-binary.ts` |
| 查询 | `src/scheme1/cli/query-hand.ts` | `src/scheme2/cli/query-hand.ts` |
| 校验 | `src/scheme1/cli/verify-binary.ts` | `src/scheme2/cli/verify-binary.ts` |
| 基准测试 | `src/scheme1/cli/benchmark-binary.ts` | `src/scheme2/cli/benchmark-binary.ts` |
| 分析 | `src/scheme1/cli/analyze-binary.ts` | — |
| 比较 | `src/scheme1/cli/benchmark-compare.ts` | — |
| 冷启动 | — | `src/scheme2/cli/benchmark-cold-start.ts` |

CLI 参数解析模式（`--dir`、`--source`、`--dimension`）在两个 scheme 中约 70-90% 重复。`package.json` 中 35 个 scripts，其中 scheme1 和 scheme2 各有一套 build/query/verify/benchmark 命名空间。

### 10. Scheme1 遗弃状态未正式化

**现状：** Scheme1 目录下所有源文件中都没有 `@deprecated` JSDoc 标签或模块级废弃注释。`package.json` 中 scheme1 脚本仍可正常执行。新开发者在 `src/scheme1/` 和 `src/scheme2/` 之间可能不确定应该使用哪个。

**建议：** 在 `src/scheme1/` 各入口模块添加 `@deprecated` 标签，并在 `check:release` 中附一条 deprecation notice。确定 scheme1 的最终下线时间点。

### 11. 查询服务测试覆盖盲区

**现状：** 查询服务有以下路径未被测试覆盖：

- **Flat TypedArray 响应路径**：`queryBatchFlat()` 使用 TypedArray 批量传输模式，测试中只有逐对象 JSON 路径的断言
- **LRU handle 池驱逐行为**：`handlePool.get()` 在池满时驱逐最久未使用的 handle，无测试验证驱逐后旧 handle 的 `close()` 被正确调用
- **`getHandsByAction()` 公开方法**：仅在 `tests/test-cases.md` 中有人工示例代码，测试套件中无自动化用例覆盖（action mask 语义、minFrequency 筛选、去重）

### 12. package.json 脚本命名空间膨胀

**现状：** 共 35 个 scripts，其中 14 个带有 `:scheme1`/`:scheme2` 前缀：

- `build:*` × 6（binary + scheme2 + native + 3 个 native 平台变体）
- `benchmark:*` × 6（sqlite + binary + scheme2 + scheme2:cold + compare + 串联）
- `verify:*` × 3（binary + scheme2 + scheme2:cross）
- `query:*` × 2 + `analyze:*` × 3 + `check:*` × 2 + `test:*` × 1 + `fmt:*` × 1

建议当 scheme1 正式下线时，清理对应的 8-10 个 scheme1 脚本。`build:native:win|linux|mac:*` 平台变体可考虑通过 `--target` 参数替代。

---

## P3 — 长期工程债务

### 13. .idx 格式定义跨语言重复

**现状：** `.idx` 二进制格式常量在两处独立定义：

| 常量 | TS 定义 | Rust 定义 |
|------|---------|-----------|
| `IDX_MAGIC` | `src/scheme2/idx/idx-types.ts:3` (`"PFXI"`) | `native-addon/src/types.rs:9` (`b"PFXI"`) |
| `IDX_HEADER_SIZE` | `src/scheme2/idx/idx-types.ts:4` (`16`) | `native-addon/src/types.rs:10` (`16`) |
| `IDX_RECORD_SIZE` | `src/scheme2/idx/idx-types.ts:5` (`22`) | `native-addon/src/types.rs:11` (`22`) |

**风险：** 两处定义无编译时同步机制，未来格式变更时（如扩展 record 字段）容易单边遗漏。

**建议（低优先级）：** 待项目稳定后在 CI 中增加跨语言常量一致性检查（解析 `idx-types.ts` 和 `types.rs`，比对输出值）。

### 14. mmap unsafe 块缺少安全文档

**现状：** `native-addon/src/bin_reader.rs:35` 和 `native-addon/src/idx_reader.rs:40` 各有一个 `unsafe { Mmap::map(&file)? }` 调用，没有安全注释说明 unsafe 必要性。

```rust
// bin_reader.rs:35
let mmap = unsafe { Mmap::map(&file)? };

// idx_reader.rs:40
let mmap = unsafe { Mmap::map(&file)? };
```

mmap 的 unsafe 风险在于：底层文件可能被外部截断，导致对已映射内存的访问触发 SIGBUS。当前代码通过 `File` 的 `OwnedHandle` 持有文件描述符来防止被操作系统回收，但无法防御外部进程通过相同路径修改文件。

**建议：** 添加 `// SAFETY:` 注释说明 mmap 安全前置条件，并记录已知风险边界。

### 15. Native 错误前缀解析为运行时字符串匹配

**现状：** Rust native addon 通过 napi `Error::from_reason()` 传递 `PFS_*` 前缀的错误消息，TS 侧通过 `parseNativeQueryErrorCode()` 做字符串前缀匹配：

```typescript
// src/query/errors.ts — 运行时字符串解析
const match = message.match(/^(PFS_[A-Z_]+):/);
```

napi-rs 当前不直接支持自定义错误枚举抛到 JS 侧，TS 端只能解析消息字符串。如果 Rust 侧错误消息格式变更（如去掉 `:` 分隔符），TS 端将静默退化到 fallback 错误码。

**建议：** 在 Rust 侧将 PFS_ 前缀解析逻辑封装到 `native_*_error()` 工具函数中，并在 Rust 单元测试中固化 `to_string()` 输出格式。

### 16. BatchQueryRequest.hand_id: u32 → u8 静默截断

**现状：** `native-addon/src/types.rs:72` 中 `BatchQueryRequest.hand_id` 声明为 `u32`，但所有调用点都执行 `hand_id as u8` 截断：

```rust
// lib.rs:70 — 所有 4 个调用点相同
self.query_inner(concrete_line_id, hand_id as u8, verify)
```

pack 格式中 hand_id 为 1 字节（0-168 合法范围），从 u32 到 u8 的 `as` 转换在值 >255 时会静默截断（取低 8 位），不会 panic。调用的 TS 代码通常传入小整数，但类型签名 (`u32`) 与实际语义 (`u8`) 不一致。

**建议：** 将 `BatchQueryRequest.hand_id` 类型改为 `u8`，或在 napi 绑定层做值范围校验。

### 17. Silent catch 块分布

**现状：** 项目中共有 18 处空 catch 块或注释-only catch 块：

| 位置 | 行为 | 风险 |
|------|------|------|
| `build-binary-store.ts` (3 处) | 返回 null/忽略/Ignore finalization races | 低：均为有文档的恢复路径 |
| `benchmark/runner.ts` (2 处) | Fallback/冷启动退化 | 低：benchmark 环境 |
| `verify/checks/*.ts` (5 处) | 推入 failures 数组 | 低：校验错误收集 |
| `cli/benchmark-binary.ts` (2 处) | `errorCount++` | 中：丢失错误根因 |
| `cli/benchmark-cold-start.ts` (1 处) | 返回失败结果 | 低：有文档 |
| `cli/benchmark-compare.ts` (2 处) | 非关键路径  | 低 |

benchmark 代码中的 catch 块尤其值得注意——benchmark 是性能信号的重要来源，静默的 `errorCount++` 会使问题排错困难。

**建议：** benchmark catch 块中增加 `console.error` 输出错误消息（受 `--quiet` flag 控制）；verify 路径已有明确的 failure 收集，是合理的模式。

### 18. 文档中 import 路径为相对路径

**现状：** `docs/` 和 `tests/test-cases.md` 中的示例代码使用 `../src/` 相对路径导入：

```ts
import { Scheme2QueryService } from "../src/scheme2/query/query-service";
```

**风险：** 项目内部路径重构时，示例代码容易过时且无人发现（无编译检查）。

**建议：** 测试用例中保持一致路径模式；文档中使用 `src/` 锚定根路径或 tsconfig paths alias。

---

## 建议执行顺序

```
已完成 P0: 性能优化（Scheme2 + Rust + 三项优化，6.2x 快于 SQLite）
  ↓
已完成 P1: CLI 参数边界测试 + 代码去重 + Husky v10 兼容性 + Float32 bit-exact + OS 冷启动 Benchmark V2
  ↓
P2 待办（推荐顺序）:
  1. scheme1 错误处理迁移（#7，EXPEDIENT，约 11 处 new Error() → PreflopStoreError）
  2. package.json 脚本清理 + scheme1 @deprecated 标注（#10 + #12，EXPEDIENT）
  3. 查询服务测试盲区补全（#11，PRUDENT）
  4. build-binary-store.ts 职责拆分（#8，PRUDENT，需设计拆分方案）
  5. Scheme1/Scheme2 CLI 合并（#9，PRUDENT，依赖 #4 和 #10 完成）
  ↓
P3 待办（低优先级，随主线演进逐步处理）:
  1. mmap unsafe 安全文档（#14，EXPEDIENT）
  2. BatchQueryRequest hand_id 类型修正（#16，EXPEDIENT）
  3. Native 错误前缀格式测试固化（#15，PRUDENT）
  4. .idx 跨语言常量一致性 CI（#13，低优先级）
  5. 文档相对路径标准化（#18，低优先级）
```
