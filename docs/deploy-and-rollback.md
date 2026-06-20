# 发布和回滚指南

> 版本：1.0
> 生成日期：2026-06-17
> 关联需求：Phase 5 生产化转换流程

## 1. 部署文件清单

一个完整的 Scheme2 数据部署包含以下文件：

```
binary-scheme2/
├── manifest.json                  # 构建清单（版本、checksum、维度列表）
├── meta.db                        # SQLite 元数据库（concrete lines, action schemas, drill scenarios）
├── ranges_{strategy}_{N}max_{BB}BB.bin   # 每个维度的二进制策略数据
└── ranges_{strategy}_{N}max_{BB}BB.idx   # 每个维度的索引文件
```

## 2. 新增数据版本

### 2.1 从新 SQLite 源构建

```powershell
# 全量构建
bun run build:scheme2 --source range-db/new-range.db --out range-db/binary-scheme2-v2

# 构建并输出统计报告
bun run build:scheme2 \
  --source range-db/new-range.db \
  --out range-db/binary-scheme2-v2 \
  --stats reports/build-scheme2-v2.json \
  --stats-md reports/build-scheme2-v2.md
```

### 2.2 仅更新部分维度

```powershell
# 只重建 default:6max:100BB 维度
bun run build:scheme2 \
  --source range-db/range.db \
  --out range-db/binary-scheme2 \
  --dimension default:6:100 \
  --overwrite
```

### 2.3 断点续跑（大维度转换中断后继续）

```powershell
bun run build:scheme2 \
  --source range-db/range.db \
  --out range-db/binary-scheme2 \
  --resume \
  --stats reports/build-scheme2.json \
  --stats-md reports/build-scheme2.md
```

`--resume` 会读取已有的 `manifest.json`，跳过已完成的维度。中途失败的维度（`.tmp` 文件残留）也会被重新构建。续跑时会比对当前 source DB checksum 和 manifest 中记录的 checksum；如果源库已变化，需要使用 `--overwrite` 从头生成一个一致的新版本。

## 3. 发布前校验流程

```powershell
# 1. 构建统计报告 — 确认无错误、压缩比合理
bun run build:scheme2 \
  --source range-db/range.db \
  --out range-db/binary-scheme2 \
  --overwrite \
  --stats reports/build-scheme2.json \
  --stats-md reports/build-scheme2.md

# 2. 构建当前平台 native addon
bun run build:native

# 3. 发布前质量检查
bun run check:release

# 4. Source DB 交叉校验（抽样；严格发布可把 --sample-size 设为 0 做全量）
bun run verify:scheme2 --mode cross --source range-db/range.db --dir range-db/binary-scheme2 --sample-size 10000 --verify-checksum

# 5. Benchmark — 校验 Scheme2 查询链路可用并抽样比对结果
bun run benchmark:scheme2 --dir range-db/binary-scheme2 --iterations 1000 --verify-results

# 6. Cold-start Benchmark — 默认覆盖 manifest 中全部成功维度，生产产物应为 9 个维度
bun run benchmark:scheme2:cold --source range-db/range.db --dir range-db/binary-scheme2 --runs 10 --concrete-line-id 1 --hand AA --mode process-cold
```

V1 native addon 构建流程以 Windows 本机为优先支持环境：Windows x64 使用 `x86_64-pc-windows-msvc`，不要使用默认 GNU target。Linux x64 GNU 和 macOS arm64/x64 已保留脚本 target，实际发布前应在对应平台本机执行 `bun run build:native` 与 `bun run check:native`。

### 校验通过标准

| 检查项 | 标准 |
|--------|------|
| Build 统计 | 0 errors，压缩比 ≤ 30% |
| Native addon | 当前平台 `bun run build:native` 成功，`bun run check:native` 通过 |
| 质量检查 | `bun run check:release` 全部通过 |
| Scheme2 standalone 校验 | manifest/meta/idx/bin/CRC 全部通过 |
| Scheme2 cross 校验 | source records failed = 0，extra binary records = 0 |
| Benchmark | p50 查询时间 ≤ 0.012ms，QPS ≥ 80K |
| 结果抽样核对 | `benchmark:scheme2 --verify-results` 无 mismatch |
| Cold-start Benchmark | `benchmark:scheme2:cold` 维度数 = 9，errorCount = 0，记录 p50/p95 作为发布基线 |

精度阈值参考 `docs/float32-precision-spec.md`。

## 4. 回滚流程

### 4.1 版本化部署（推荐）

采用目录版本化管理，保留至少上一个版本的完整数据：

```
range-db/
├── binary-scheme2-v1/     # 当前生产版本
├── binary-scheme2-v2/     # 新版本（验证通过后切换）
└── binary-scheme2/        # 软链接 → v1（应用程序指向此路径）
```

回滚步骤：
```powershell
# 1. 切换软链接（应用程序立即生效）
rm range-db/binary-scheme2
ln -s range-db/binary-scheme2-v1 range-db/binary-scheme2

# 2. 如果有运行中的服务，重启
# systemctl restart preflop-storage
```

### 4.2 原地回滚

如果未使用版本化目录，从备份恢复：

```powershell
# 从备份恢复（提前备份是必须的）
cp -r range-db/binary-scheme2-backup/* range-db/binary-scheme2/
```

### 4.3 通过 manifest.json 检查当前版本

```json
{
  "format": "PFSP",
  "version": 1,
  "sourceDbChecksum": "a1b2c3d4...",
  "builtAt": "2026-06-17T10:30:00.000Z",
  "dimensions": [
    { "strategy": "default", "playerCount": 6, "depthBb": 100, "concreteLineCount": 1234, "packCount": 1234 }
  ],
  "files": ["meta.db", "ranges_default_6max_100BB.bin", "ranges_default_6max_100BB.idx"]
}
```

通过 `sourceDbChecksum` 确认当前部署对应哪个 SQLite 源数据版本。

## 5. 损坏文件检测

### 5.1 运行时检测

查询服务通过以下机制检测数据损坏：

- **CRC32C 校验**：每个 range pack 的 CRC32C 记录在 .idx 文件中。启用 `verifyChecksums: true` 后，每次查询都会验证 CRC32C。
- **BIN_FILE_NOT_FOUND**：文件缺失时返回指定错误码。
- **INVALID_FORMAT**：二进制 header 不匹配时抛出 `PreflopStoreError`。

### 5.2 定期检测

```powershell
# 对当前部署目录执行可用性检查与抽样结果核对
bun run verify:scheme2 --mode standalone --dir range-db/binary-scheme2 --verify-checksum
bun run verify:scheme2 --mode cross --source range-db/range.db --dir range-db/binary-scheme2 --sample-size 10000 --verify-checksum
bun run benchmark:scheme2 --dir range-db/binary-scheme2 --verify-results
```

### 5.3 损坏恢复

1. 从独立备份恢复对应文件
2. 如无备份，使用 `--resume` 重建受影响维度
3. 重建后重新执行 `bun run check:release`、`bun run verify:scheme2 --mode cross --verify-checksum` 和 `bun run benchmark:scheme2 --verify-results`

## 6. 断点续跑实现细节

### 6.1 .tmp 原子化

每个维度在构建时先写入 `.tmp` 后缀的临时文件，构建完成后原子 `rename` 为目标文件名：

```
构建中：ranges_default_6max_100BB.bin.tmp / .idx.tmp
完成后：ranges_default_6max_100BB.bin / .idx
```

中途崩溃时，`.tmp` 文件会在下次 `--overwrite` 或 `--resume` 时被覆盖。

### 6.2 manifest.json 记录

`manifest.json` 在每次成功构建后更新，包含已完成维度的列表和 `sourceDbChecksum`。`--resume` 读取此列表跳过已完成维度，但只允许在 source DB checksum 一致时续跑。

```powershell
# 重新构建失败或新增的维度
bun run build:scheme2 --out range-db/binary-scheme2 --resume

# 从零重建整个数据集
bun run build:scheme2 --out range-db/binary-scheme2 --overwrite
```

## 7. 构建统计报告

### 7.1 JSON 报告结构

```json
{
  "generatedAt": "2026-06-17T10:30:00.000Z",
  "sourceDbPath": "range-db/range.db",
  "sourceDbSizeBytes": 1516838912,
  "outDir": "range-db/binary-scheme2",
  "outputTotalSizeBytes": 360710144,
  "outputMetaDbSizeBytes": 2097152,
  "compressionRatio": 0.2378,
  "dimensions": [
    {
      "strategy": "default",
      "playerCount": 6,
      "depthBb": 100,
      "concreteLineCount": 1234,
      "packCount": 1234,
      "binFileSizeBytes": 52428800,
      "idxFileSizeBytes": 27148,
      "srcRowCount": 208346,
      "durationMs": 2500,
      "error": null
    }
  ],
  "totals": {
    "dimensionCount": 12,
    "concreteLineCount": 14808,
    "packCount": 14808,
    "srcRowCount": 2500152,
    "totalDurationMs": 32000,
    "errorCount": 0
  }
}
```

### 7.2 命令行输出

```powershell
bun run build:scheme2 \
  --source range-db/range.db \
  --out range-db/binary-scheme2 \
  --overwrite \
  --stats-md reports/build-scheme2.md
```

## 8. 相关文档

- `docs/float32-precision-spec.md` — 精度校验标准
- `docs/error-handling-strategy.md` — 错误处理策略
- `docs/requirements-status-and-plan.md` — 需求和整体状态
- `docs/issues-and-action-items.md` — 已知问题和待办项
