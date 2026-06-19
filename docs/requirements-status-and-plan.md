# 项目进度与状态

最后更新：2026-06-19

这份文档只记录当前已经落地的能力、最近完成的变更，以及下一步还需要继续补强的点。历史方案推演和早期计划已经不再作为主线，当前默认推荐使用 **Scheme2 + Rust**。

## 当前结论

项目当前已经具备一套可运行、可构建、可查询、可测试的翻前策略存储方案：

- 构建链路：旧 SQLite -> `meta.db + .idx + .bin`
- 查询链路：TypeScript 元数据查询 + Rust `napi-rs` 热路径
- 工程保障：类型检查、ESLint、Bun 测试、benchmark 报告、部署文档
- 构建恢复：`manifest.json`、`--resume`、临时文件原子提交、构建统计报告

当前推荐使用：

- 构建：`bun run build:scheme2`
- 查询：`bun run query:scheme2`
- 校验：`bun run verify:scheme2`
- 压测：`bun run benchmark:scheme2`

## 当前进度总览

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 数据格式设计 | 已完成 | `PFSP` 二进制格式、`.idx` 索引格式、action schema 编解码已稳定 |
| Scheme1 构建/查询 | 已完成 | 保留作兼容与对照路径 |
| Scheme2 构建/查询 | 已完成 | 当前主线路径，查询热路径走 Rust |
| Rust 原生插件 | 已完成 | `DimensionHandle` 已接管 `.idx + .bin` 热路径 |
| 构建续跑与 manifest | 已完成 | 支持 `--resume`、失败维度重建、旧产物清理 |
| 构建统计报告 | 已完成 | `--stats` / `--stats-md` 可输出 JSON 和 Markdown |
| 分析报告 | 已完成 | SQLite 分析、存储分析、benchmark 报告已落盘到 `reports/` |
| 查询 SDK 文档 | 已完成 | 见 `docs/query-sdk.md` |
| 部署/回滚文档 | 已完成 | 见 `docs/deploy-and-rollback.md` |
| 自动化全量校验（Scheme2 专用） | 已完成 | `verify:scheme2` 支持 standalone 自检 + cross 交叉校验 |

## 最近完成的变更

### 1. Scheme2 全量校验命令（新增）

新增 `bun run verify:scheme2` 命令，提供两条校验链路：

- **standalone 模式（默认）**：不依赖 source DB，对 `manifest.json`、`meta.db`、`.idx`、`.bin` 做文件存在性、格式魔数、CRC32C 完整性、引用交叉校验。适合生产部署前自检。
- **cross 模式**：叠加 source DB（`range.db`）交叉校验，对每条记录的 frequency/handEV 做逐行对比（采样 + 全量），复用了 Scheme1 的容差策略。

相关代码：
- `src/scheme2/cli/verify-binary.ts` — CLI 入口
- `src/scheme2/verify/checks/manifest.ts` — manifest.json 自检
- `src/scheme2/verify/checks/meta-db.ts` — meta.db 自检（action_schema checksum、schema_key）
- `src/scheme2/verify/checks/idx-structure.ts` — .idx 魔数、版本、记录排序
- `src/scheme2/verify/checks/bin-structure.ts` — .bin 魔数、版本
- `src/scheme2/verify/checks/idx-bin-cross.ts` — .idx ↔ .bin 交叉引用 + CRC32C + pack 结构
- `src/scheme2/verify/checks/source-cross.ts` — source DB 交叉数据校验
- `src/scheme2/verify/report.ts` — JSON/Markdown 报告生成
- `tests/scheme2-verify.test.ts` — 12 个测试用例

验证结果（针对 range-db/binary-scheme2，9 维度，521K packs）：
- standalone：全部通过
- standalone + CRC：521K packs CRC32C 校验全部通过
- cross（采样 500 条）：0 失败

`src/scheme2/importer/build-binary-store.ts` 现在已经补上下面几件事：

- `manifest.json` 记录每个维度的状态：`success` / `failed`
- `--resume` 只跳过真正构建成功且产物完整的维度
- 恢复时会校验 `.bin` / `.idx` 是否存在，以及文件大小是否与 manifest 对得上
- `--resume` 会比对当前 source DB checksum 和 manifest 中记录的 checksum；源库变化时会拒绝续跑，要求使用 `--overwrite` 重新构建
- `--overwrite` 会清理上一次构建遗留的 `meta.db`、manifest、维度文件和 `.tmp` 文件
- 单维度构建失败时不会把临时文件误当成成功产物

这次修复的重点是避免“上次失败的维度在 resume 时被误判为已完成”，以及避免“旧成功维度被复用到新 source DB”。

### 2. Scheme2 构建测试补齐

新增并通过了以下关键测试：

- `resume skips successful dimensions and rebuilds failed dimensions`
- `resume rejects when source DB checksum changed`
- `overwrite removes files listed by the previous manifest`
- `writes JSON and Markdown build stats`

这部分测试位于 `tests/scheme2-build.test.ts`。

### 3. 当前质量状态

最近一次质量检查结果：

- `bun run typecheck` 通过
- `bun run lint` 通过
- `bun test` 通过
- `cargo test --manifest-path native-addon/Cargo.toml` 通过
- 总计 `102` 个 Bun 测试通过，`17` 个 Rust 测试通过

## 当前产物与能力

### 构建产物

完整的 Scheme2 输出目录包含：

```text
binary-scheme2/
  manifest.json
  meta.db
  ranges_{strategy}_{N}max_{BB}BB.idx
  ranges_{strategy}_{N}max_{BB}BB.bin
```

其中：

- `manifest.json`：构建清单、维度状态、文件元数据
- `meta.db`：drill 场景、concrete line、action schema
- `.idx`：维度级索引，供 Rust 做 mmap + 二分查找
- `.bin`：真实策略矩阵

### 查询能力

当前已经可用的主要能力：

- 单手牌查询
- 批量手牌查询
- drill 场景 -> abstract line 查询
- abstract line -> concrete line 查询
- 按 action 过滤手牌
- 同步热路径查询（预热后）

主入口是 `src/scheme2/query/query-service.ts`。

## 现有报告摘要

### 存储体积

基于已有报告，当前新格式总大小约为：

- 旧 SQLite：约 `1.41 GB`
- 新二进制：约 `346.51 MB`
- 体积降幅：约 `76%`

参考：`reports/storage-analysis.md`

### 查询性能

基于 `reports/benchmark-scheme2.md` 与 `reports/benchmark-sqlite.md`：

- 单手牌查询 p50：SQLite `0.038 ms`，Scheme2 `0.009 ms`
- batch-20 查询 p50：SQLite `0.683 ms`，Scheme2 `0.096 ms`
- 综合 QPS：SQLite `1401`，Scheme2 `8701`

当前主要 tradeoff：

- 热路径更快
- 冷启动更慢
- RSS 更高

## 还需要继续补强的点

### 1. 运行时错误语义进一步收束

Rust 热路径启用 CRC 校验后，如果 pack 损坏，目前更偏向返回查询 miss。后续建议把 checksum mismatch、越界索引等数据损坏场景映射成明确的结构化错误，便于生产告警和自动恢复。

### 2. Native addon 发布流水线

当前已有 `test:native` 和发布前检查脚本，但 native addon 的跨平台构建/产物分发还主要依赖手工执行 `bunx @napi-rs/cli build --platform --release`。后续建议把 native 构建纳入 CI 或发布脚本。

### 3. 文档进一步收束

大部分主线文档已经切到 Scheme2 + Rust，但部分历史测试说明仍带有旧路径。后续可以继续把文档口径统一到以下主线：

- 当前推荐方案是 Scheme2 + Rust
- Scheme1 只保留给兼容、回归和对比测试
- benchmark 聚合脚本与 README 需要持续保持同一口径

### 4. 发布前验证闭环

当前已经具备：

- 构建统计
- 部署/回滚说明
- benchmark 报告
- 测试覆盖
- Scheme2 standalone / cross 校验
- `check:release` 发布前检查脚本

后续还建议补强：

- manifest 版本升级策略说明
- 冷启动和 OS page cache benchmark 的固定发布阈值

## 建议的日常使用顺序

```powershell
# 1. 安装依赖
bun install

# 2. 构建 Rust 原生插件
cd native-addon
cargo test
bunx @napi-rs/cli build --platform --release

# 3. 回到项目根目录
cd ..

# 4. 跑质量检查
bun run check

# 5. 构建 Scheme2 数据
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --overwrite

# 6. 发布前额外检查：Bun + Rust + Scheme2 standalone 自检
bun run check:release

# 7. 查询验证
bun run query:scheme2 --dir range-db/binary-scheme2 --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
```

## 相关文档

- `README.md`：项目总览、安装构建、主要脚本说明
- `docs/query-sdk.md`：查询 SDK 用法
- `docs/deploy-and-rollback.md`：部署与回滚
- `docs/float32-precision-spec.md`：Float32 精度约束
- `docs/issues-and-action-items.md`：问题与待办
- `reports/`：分析、校验、benchmark 输出
