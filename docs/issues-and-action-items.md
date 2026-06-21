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

### 9. Scheme1 / Range Strata Binary CLI 重复 ✅ **已解决 V1**

**最终状态（2026-06-21）：** 已新增统一 CLI 分发层，package scripts 不再直接分散指向各 scheme 的实现文件。主路径默认走 Range Strata Binary，legacy Scheme1 / SQLite baseline 只能通过显式 scheme 或单用途命令进入。

已补充：

- `src/cli/command-router.ts`：统一解析 `<command> --scheme <range-strata|scheme1|sqlite>` 并映射到底层入口
- `src/cli/main.ts`：统一执行入口，转发到现有 CLI 文件
- `package.json`：新增 `cli`，并让 `build` / `query` / `verify` / `benchmark*` 统一走 `src/cli/main.ts`
- `tests/cli-command-router.test.ts`：覆盖默认主线、Scheme1 legacy、SQLite baseline 和错误组合

V1 仍保留旧 CLI 文件，保证显式文件路径调用兼容；后续可以在 `0.3.0` 移除 Scheme1 时删除 legacy 入口。

### 10. Scheme1 遗弃状态未正式化 ✅ **已解决**

**最终状态（2026-06-21）：** Scheme1 已正式标记为 deprecated，只保留给旧数据兼容、SQLite 基线对比和历史校验。新构建、查询、校验和 benchmark 均应使用 Range Strata Binary。

已补充：

- `src/scheme1/cli/*.ts`：入口模块级 `@deprecated` 注释
- `src/scheme1/` 公开导出的 API：`@deprecated` JSDoc，覆盖 `MetaDb`、`initBinaryMetaDb`、`buildBinaryStore`、`PreflopQueryService` 及相关类型
- `scripts/release-notices.ts`：发布检查前输出 Scheme1 deprecation notice
- `package.json`：`check:release` 接入 release notice
- `README.md` / `docs/query-sdk.md`：说明 Scheme1 仅用于兼容和对比

**下线策略：** Scheme1 保留到 `0.2.x` 兼容窗口结束，目标在 `0.3.0` 移除。

### 11. 查询服务测试覆盖盲区 ✅ **已解决**

**最终状态（2026-06-21）：** 所有三项盲区已补全：

- ✅ `tests/range-strata-query-service.test.ts`（7 个用例）：空批量请求（3 个 API）、不存在维度返回 BIN_FILE_NOT_FOUND、`minFrequency` 严格下界（0.499/0.5/0.55 三组）、`handEV=null` 与 `handEV=0` 区分
- ✅ `tests/binary-codec.test.ts`：action mask 语义已覆盖
- ✅ `native-addon/src/pack_codec.rs`：NaN EV 解码为 None、169 手牌×32 动作最大布局
- ✅ Flat TypedArray 响应路径通过批量查询测试间接覆盖（`getHandStrategiesBatch` → `queryBatchFlat`）
- ✅ LRU handle pool：封装在 `dimension-handle-pool.ts` 独立模块中，通过查询服务集成测试覆盖

### 12. package.json 脚本命名空间

**现状（2026-06-21）：** 共 23 个 scripts（新增统一 `cli` 分发入口），结构清晰：

- `cli` + `build:*` × 6（build + native + 4 个 native 平台变体）
- `benchmark:*` × 3（benchmark + benchmark:cold + benchmark:sqlite + benchmark:compare）
- `verify:*` × 2（verify + verify:cross）
- `query` + `check:*` × 3 + `test:*` + `lint` + `typecheck` + `fmt:native:check`

scheme1 的 build/query/verify/benchmark 不再作为独立 package scripts 暴露；需要时通过 `bun run cli <command> --scheme scheme1` 显式进入 legacy 路径。`build:native:win|linux|mac:*` 平台变体可考虑通过 `--target` 参数替代。

---

## P3 — 长期工程债务

### 13. .idx 格式定义跨语言重复 ✅ **已解决**

**最终状态（2026-06-21）：** 已新增 `tests/idx-format-constants.test.ts`，在 `bun test` 中解析 TypeScript 与 Rust 两侧的 `.idx` 格式常量并做一致性断言。

| 常量 | TS 定义 | Rust 定义 |
|------|---------|-----------|
| `IDX_MAGIC` | `src/range-strata-binary/index/types.ts:3` (`"PFXI"`) | `native-addon/src/types.rs:9` (`b"PFXI"`) |
| `IDX_HEADER_SIZE` | `src/range-strata-binary/index/types.ts:4` (`16`) | `native-addon/src/types.rs:10` (`16`) |
| `IDX_RECORD_SIZE` | `src/range-strata-binary/index/types.ts:5` (`22`) | `native-addon/src/types.rs:11` (`22`) |

该测试随 `bun test` / `bun run check` 执行，未来若任一侧单独修改 `IDX_MAGIC`、`IDX_HEADER_SIZE` 或 `IDX_RECORD_SIZE`，测试会失败。

### 14. mmap unsafe 块缺少安全文档 ✅ **已解决**

**最终状态（2026-06-21）：** `native-addon/src/bin_reader.rs` 和 `native-addon/src/idx_reader.rs` 中的 `unsafe { Mmap::map(&file)? }` 块都已补充 `// SAFETY:` 注释。

```rust
// bin_reader.rs
// SAFETY: the file is opened read-only, has already been checked to be
// at least large enough for the fixed PFSP header, and the `File` is
// kept alive in `BinReader` for the full lifetime of the mmap.
let mmap = unsafe { Mmap::map(&file)? };

// idx_reader.rs
// SAFETY: the file is opened read-only, has already been checked to be
// at least large enough for the fixed .idx header, and the `File` is
// kept alive in `IdxReader` for the full lifetime of the mmap.
let mmap = unsafe { Mmap::map(&file)? };
```

注释明确记录了安全前置条件：只读打开、最小长度检查、`File` 与 mmap 同生命周期、访问前做边界验证。同时保留已知风险边界：如果外部进程在 `DimensionHandle` 存活期间截断或原地修改同一文件，OS 映射仍可能失效；部署侧应使用版本化目录并切换 handle，而不是原地覆盖文件。

### 15. Native 错误前缀解析为运行时字符串匹配 ✅ **已解决**

**最终状态（2026-06-21）：** Rust native addon 已将 `PFS_*` 错误格式集中到 `native_prefixed_error()`，并在 Rust 单元测试中固化 `to_string()` 的精确输出格式。

```rust
fn native_prefixed_error(code: &str, message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(format!("{}: {}", code, message.into()))
}
```

已覆盖：

- `PFS_INVALID_FORMAT`
- `PFS_CHECKSUM_MISMATCH`
- `PFS_BIN_FILE_NOT_FOUND`
- `PFS_UNSUPPORTED_DATA_VERSION`
- `PFS_IO_ERROR`

napi-rs 当前仍不直接暴露自定义错误枚举给 JS；TS 侧继续解析消息前缀，但 Rust 测试会防止格式被无意改坏。

### 16. BatchQueryRequest.hand_id: u32 → u8 静默截断 ✅ **已解决**

**最终状态（2026-06-21）：** native napi 边界已新增 `validate_hand_id()`，所有 `query` / `query_batch` / `query_batch_flat` / `query_batch_count` 调用都先校验 `hand_id` 是否在合法 169 手牌范围 `0..=168`，再转换为 `u8`。超出范围会抛出 `PFS_INVALID_FORMAT`，不会再静默截断。

```rust
fn validate_hand_id(hand_id: u32) -> napi::Result<u8> {
    if hand_id <= 168 {
        return Ok(hand_id as u8);
    }

    Err(native_invalid_format(format!(
        "Invalid hand_id: {}, expected 0..=168",
        hand_id
    )))
}
```

保留 `BatchQueryRequest.hand_id: u32` / JS-facing `number`，避免改变 napi 生成的 TypeScript API；修复点放在 Rust 边界层。已补充 Rust 单元测试覆盖 `0`、`168` 通过，`169`、`256` 失败并保留 `PFS_INVALID_FORMAT` 前缀。

### 17. Silent catch 块分布 ✅ **已解决**

**最终状态（2026-06-21）：** pipeline.ts 和 benchmark/runner.ts 中的空 catch 块已替换为 `warnRecoverable()`（输出 `console.warn`）。benchmark CLI 中的 `errorCount++` 已替换为显式错误收集。verify/checks 路径的 catch 块将错误推入 failures 数组，是合理的校验模式。仅 `cold-benchmark.ts:436` 保留了一个 `rm(force:true).catch(() => {})`，属于无害的清理路径。

### 18. 文档中 import 路径为相对路径 ✅ **已解决**

**最终状态（2026-06-21）：** `docs/`、`tests/test-cases.md` 和 `README.md` 中已无 `../src` / `../../src` 相对 import 示例。文档示例统一使用项目根路径语义（如 `src/...`）或 CLI 命令入口。

验证命令：

```powershell
rg -n "\.\./src|\.\./\.\./src|from ['\"]\.\.|import .*src/" docs tests\test-cases.md README.md
```

结果无命中。

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
  7. ✅ scheme1 @deprecated 标注（#10，入口模块 + 公开 API + release notice）
  8. ✅ Scheme1/Range Strata Binary CLI 合并 V1（#9，统一 cli router + package scripts 收口）
  ↓
P2 待办（推荐顺序）:
  1. 暂无高优先级 P2 待办；进入 P3 低优先级债务
  ↓
P3 已完成：
  1. ✅ mmap unsafe 安全文档（#14）
  2. ✅ BatchQueryRequest hand_id 范围校验（#16）
  3. ✅ Native 错误前缀格式测试固化（#15）
  4. ✅ .idx 跨语言常量一致性检查（#13）
  5. ✅ 文档相对路径标准化（#18）
```
