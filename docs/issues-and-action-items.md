# 项目问题清单与行动计划

> 生成日期：2026-06-12
> 更新日期：2026-06-21（brooks-health 四轮审计 75→91 + 文档修正）
> 基于项目全量代码审查结果

---

## P0 — 生产阻塞

### 1. 二进制查询性能严重劣于 SQLite ✅ **已解决**

**最终状态（2026-06-16）：** 通过三项优化（Flat TypedArray 批量传输 + 维度级 schema 预加载 + LRU handle 池），Range Strata Binary + Rust 的热路径延迟全面超越 SQLite：

| case | SQLite p50 | Range Strata Binary 优化后 p50 | 提升 |
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

**现状（2026-06-21）：** 已有 143 个 Bun 测试，覆盖 range-strata-binary 查询服务、构建续跑/manifest、verify、自检/交叉校验、pack 编解码、文件格式、CLI 参数解析边界值、native build script smoke test、benchmark 输出校验、Float32 bit-exact 精度校验、OS 冷启动 benchmark 输出等。测试通过 `bun test` 和 pre-commit hook 运行。

**已补充：**
- ✅ CLI 参数解析边界测试（`tests/cli-args.test.ts`，50 个用例，覆盖 parseCliArgs/getStringArg/getNumberArg/getBooleanArg/getNumberListArg/getRepeatedStringArgs）
- ✅ Range Strata Binary 构建管线测试（`tests/range-strata-compile.test.ts`，覆盖 build、resume、overwrite、manifest、stats、查询错误语义）
- ✅ Native build script smoke test（`tests/native-build-script.test.ts`，覆盖 target 列表、dry-run、`--` 分隔符和不支持 target）
- ✅ Benchmark 输出校验（`tests/benchmark-output.test.ts`，覆盖 Range Strata Binary benchmark JSON/Markdown 输出、`--verify-results` note、错误计数和非 0 退出码）
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
| `filterDimensions()` | 3（实为 4，含 range-strata-binary） | `src/utils/dimension.ts` | 统一为 `DimensionSpec[] \| null \| undefined` 签名 |
| `parseDimension()` | 2（实为 3，含 range-strata-binary） | `src/utils/dimension.ts` | 返回 `DimensionSpec` 类型 |

所有 9 个原文件中的本地定义已移除，改为从 `src/utils/` 导入。

### 5. Float32 精度差异 ✅ **已解决 V1**

**最终状态（2026-06-20）：** 已将固定容差策略升级为 Float32 bit-exact 策略。

新的硬标准是：`decoded` 必须等于 `Math.fround(source)`，并且 Float32 bit pattern 一致。这样只允许 IEEE754 Float32 正确舍入带来的不可避免量化损失，不允许编码、解码、字节序、Rust/JS 转换或验证逻辑引入额外损失。

已补充：

- `docs/float32-precision-spec.md`：Float32 bit-exact 精度策略
- `src/precision/float32.ts`：Float32 bits、round-trip 校验、量化误差统计
- `src/range-strata-binary/integrity/checks/source-cross.ts`：cross verify 使用 bit-exact 校验，并输出 `precision` 统计
- `tests/float32-precision.test.ts`：精度工具测试
- `tests/range-strata-verify.test.ts`：覆盖“旧容差会放过但 Float32 bit 不一致必须失败”的边界 case

历史观测值仍保留为报告参考：全量验证曾发现 2380 万条记录中约 70 条 `hand_ev` 固定容差边界 case，最大量化误差约 `0.000015`，集中在 `default:9max:300BB AA/raise` 场景。

### 6. OS 冷启动 Benchmark ✅ **已解决 V2**

**最终状态（2026-06-20）：** 已新增 `bun run benchmark:cold` 和自动化测试（3 个用例）。

V1 基础能力：

- `src/range-strata-binary/cli/cold-benchmark.ts`：父进程入口，默认读取 manifest 全部成功维度；生产产物应覆盖 9 个维度。
- `src/range-strata-binary/cli/cold-worker.ts`：单次 fresh process worker。
- `tests/cold-start-benchmark.test.ts`：2 维度 fixture 测试。
- `package.json`：`benchmark:cold`。

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
bun run benchmark:cold --source range-db/range.db --dir range-db/range-strata-binary --runs 10 --query-policy fixed --concrete-line-id 1 --hand AA --mode process-cold
```

当前本机基线（2026-06-20）：9 个维度、90 runs、0 errors；aggregate store open+first-query p50 / p95 为 `340.36 ms / 2822.17 ms`，aggregate process elapsed p50 / p95 为 `518.28 ms / 3023.35 ms`。阶段拆分显示主要瓶颈是 `Dimension prewarm`，p50 / p95 为 `338.85 ms / 2820.40 ms`；首查 decode p50 / p95 仅 `0.46 ms / 0.70 ms`。Phase accounting 一致性：90 runs 最大 `unaccountedMs` 0.185ms。报告见 `reports/benchmark-cold-start.md`。

### 7. 错误处理风格不一致 ✅ **已解决**

**最终状态（2026-06-21）：** scheme1 侧用户可见失败路径已统一迁移到 `PreflopStoreError`，调用方可以通过 `code` 路由处理构建、格式和参数错误。`rg -n "new Error\(" src/scheme1` 已无命中。

**已迁移：**

| 文件 | 位置 | 问题 |
|------|------|------|
| `src/scheme1/importer/build-binary-store.ts` | 4 处 | 输出已存在、构建语句缺失 → `BUILD_ERROR` |
| `src/scheme1/cli/analyze-sqlite.ts` | 3 处 | 表名解析失败、PRAGMA 返回值异常 → `INVALID_FORMAT` |
| `src/scheme1/cli/benchmark-compare.ts` | 2 处 | benchmark 报告引擎类型不匹配 → `INVALID_FORMAT` |
| `src/scheme1/cli/verify-binary.ts` | 3 处 | 数据缺失、action schema 缺失 → `INVALID_FORMAT`；参数错误 → `INVALID_ARGUMENT` |

### 8. build-binary-store.ts 职责单石 ✅ **已解决**

**最终状态（2026-06-21）：** `src/range-strata-binary/compiler/pipeline.ts` 已从 676 行拆分为 173 行的编排层 + 5 个独立模块：

| 新文件 | 职责 |
|--------|------|
| `compiler/build-metadata.ts` | 源库 drill/concrete 元数据拷贝 |
| `compiler/build-report.ts` | manifest.json 写入 + JSON/Markdown 构建报告 |
| `compiler/build-statements.ts` | SQL prepared statement 管理 |
| `compiler/dimension-builder.ts` | 单维度 .idx/.bin 构建流水线 |
| `compiler/manifest.ts` | manifest.json 读写与 schema 校验 |

pipeline.ts 现在仅保留构建编排（plan、overwrite/resume 决策）、source DB checksum 计算和模块协调。

### 9. Scheme1 / Range Strata Binary CLI 重复

**现状：** CLI 入口有 6 个 scheme1 脚本 + 6 个 range-strata-binary 脚本，重叠模式明显：

| 功能 | Scheme1 | Range Strata Binary |
|------|---------|---------|
| 构建 | `src/scheme1/cli/build-binary.ts` | `src/range-strata-binary/cli/compile.ts` |
| 查询 | `src/scheme1/cli/query.ts` | `src/range-strata-binary/cli/query.ts` |
| 校验 | `src/scheme1/cli/verify-binary.ts` | `src/range-strata-binary/cli/verify.ts` |
| 基准测试 | `src/scheme1/cli/benchmark-binary.ts` | `src/range-strata-binary/cli/benchmark.ts` |
| 分析 | `src/scheme1/cli/analyze-binary.ts` | — |
| 比较 | `src/scheme1/cli/benchmark-compare.ts` | — |
| 冷启动 | — | `src/range-strata-binary/cli/cold-benchmark.ts` |

CLI 参数解析模式（`--dir`、`--source`、`--dimension`）在两个 scheme 中约 70-90% 重复。所有 CLI 入口已支持 `--help` 和参数校验（`assertKnownArgs`）。`package.json` 中 22 个 scripts，其中 scheme1 和 range-strata-binary 各有一套 build/query/verify/benchmark 命名空间。共享的 `src/cli/args.ts` 和 `src/db/meta-line-reader.ts` 减少了部分重复。

### 10. Scheme1 遗弃状态未正式化

**现状：** Scheme1 目录下所有源文件中都没有 `@deprecated` JSDoc 标签或模块级废弃注释。`package.json` 中 scheme1 脚本仍可正常执行。新开发者在 `src/scheme1/` 和 `src/range-strata-binary/` 之间可能不确定应该使用哪个。

**建议：** 在 `src/scheme1/` 各入口模块添加 `@deprecated` 标签，并在 `check:release` 中附一条 deprecation notice。确定 scheme1 的最终下线时间点。

### 11. 查询服务测试覆盖盲区 ✅ **已解决**

**最终状态（2026-06-21）：** 所有三项盲区已补全：

- ✅ `tests/range-strata-query-service.test.ts`（7 个用例）：空批量请求（3 个 API）、不存在维度返回 BIN_FILE_NOT_FOUND、`minFrequency` 严格下界（0.499/0.5/0.55 三组）、`handEV=null` 与 `handEV=0` 区分
- ✅ `tests/binary-codec.test.ts`：action mask 语义已覆盖
- ✅ `native-addon/src/pack_codec.rs`：NaN EV 解码为 None、169 手牌×32 动作最大布局
- ✅ Flat TypedArray 响应路径通过批量查询测试间接覆盖（`getHandStrategiesBatch` → `queryBatchFlat`）
- ✅ LRU handle pool：封装在 `dimension-handle-pool.ts` 独立模块中，通过查询服务集成测试覆盖

### 12. package.json 脚本命名空间

**现状（2026-06-21）：** 共 22 个 scripts（已从 35 精简至 22，commit 7778d92），结构清晰：

- `build:*` × 6（build + native + 4 个 native 平台变体）
- `benchmark:*` × 3（benchmark + benchmark:cold + benchmark:sqlite + benchmark:compare）
- `verify:*` × 2（verify + verify:cross）
- `query` + `check:*` × 3 + `test:*` + `lint` + `typecheck` + `fmt:native:check`

scheme1 的 build/query/verify/benchmark 不再通过 package.json scripts 映射，需通过显式文件路径运行。`build:native:win|linux|mac:*` 平台变体可考虑通过 `--target` 参数替代。

---

## P3 — 长期工程债务

### 13. .idx 格式定义跨语言重复

**现状：** `.idx` 二进制格式常量在两处独立定义：

| 常量 | TS 定义 | Rust 定义 |
|------|---------|-----------|
| `IDX_MAGIC` | `src/range-strata-binary/index/types.ts:3` (`"PFXI"`) | `native-addon/src/types.rs:9` (`b"PFXI"`) |
| `IDX_HEADER_SIZE` | `src/range-strata-binary/index/types.ts:4` (`16`) | `native-addon/src/types.rs:10` (`16`) |
| `IDX_RECORD_SIZE` | `src/range-strata-binary/index/types.ts:5` (`22`) | `native-addon/src/types.rs:11` (`22`) |

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

### 17. Silent catch 块分布 ✅ **已解决**

**最终状态（2026-06-21）：** pipeline.ts 和 benchmark/runner.ts 中的空 catch 块已替换为 `warnRecoverable()`（输出 `console.warn`）。benchmark CLI 中的 `errorCount++` 已替换为显式错误收集。verify/checks 路径的 catch 块将错误推入 failures 数组，是合理的校验模式。仅 `cold-benchmark.ts:436` 保留了一个 `rm(force:true).catch(() => {})`，属于无害的清理路径。

### 18. 文档中 import 路径为相对路径

**现状：** `docs/` 和 `tests/test-cases.md` 中的示例代码使用 `../src/` 相对路径导入：

```ts
import { RangeStrataQueryService } from "../src/range-strata-binary/query/service";
```

**风险：** 项目内部路径重构时，示例代码容易过时且无人发现（无编译检查）。

**建议：** 测试用例中保持一致路径模式；文档中使用 `src/` 锚定根路径或 tsconfig paths alias。

---

## 建议执行顺序

```
已完成 P0: 性能优化（Range Strata Binary + Rust + 三项优化，6.2x 快于 SQLite）
  ↓
已完成 P1: CLI 参数边界测试 + 代码去重 + Husky v10 兼容性 + Float32 bit-exact + OS 冷启动 Benchmark V2
  ↓
已完成 P2（2026-06-21）:
  1. ✅ build-binary-store.ts 职责拆分（#8，拆为 5 个模块）
  2. ✅ 查询服务测试盲区补全（#11，7 个用例覆盖全部盲区）
  3. ✅ Silent catch 块修复（#17，warnRecoverable 替代空 catch）
  4. ✅ package.json 脚本精简（35→22）+ CLI --help / 参数校验
  5. ✅ 文档路径和类名修正（18 处过期引用）
  6. ✅ scheme1 错误处理迁移（#7，12 处 new Error() → PreflopStoreError）
  ↓
P2 待办（推荐顺序）:
  1. scheme1 @deprecated 标注（#10，EXPEDIENT）
  2. Scheme1/Range Strata Binary CLI 合并（#9，PRUDENT，依赖 #10 完成）
  ↓
P3 待办（低优先级，随主线演进逐步处理）:
  1. mmap unsafe 安全文档（#14，EXPEDIENT）
  2. BatchQueryRequest hand_id 类型修正（#16，EXPEDIENT）
  3. Native 错误前缀格式测试固化（#15，PRUDENT）
  4. .idx 跨语言常量一致性 CI（#13，低优先级）
  5. 文档相对路径标准化（#18，低优先级）
```
