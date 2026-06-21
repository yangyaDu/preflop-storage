# Preflop Storage 测试用例

本文档用于记录 Preflop Storage 项目的核心测试用例，覆盖二进制格式、旧 SQLite 转换、查询读取、配置参数和异常场景。

## 测试范围

主要测试对象：

- `src/binary/`：二进制 header、action schema、range pack、CRC32C。
- `src/range-strata-binary/compiler/`：旧 SQLite 到 `meta.db + .idx + .bin` 的主构建流程。
- `src/range-strata-binary/query/`：Range Strata Binary + Rust 热路径查询服务。
- `src/range-strata-binary/cli/`：Range Strata Binary 构建、查询、校验和 benchmark 命令。

## 测试环境

前置条件：

- 已安装 Bun。
- 根目录存在 `range-db/range.db`。
- 当前工作目录为项目根目录。

检查命令：

```powershell
bun --version
Get-Item range-db/range.db
```

## 用例 1：运行单元测试

测试目标：

验证二进制 codec、CRC、header、range pack 的基础能力正常。

执行命令：

```powershell
bun test
```

预期结果：

- 所有测试通过。
- 输出中没有 `fail`。

## 用例 2：构建小样本二进制库

测试目标：

验证旧 SQLite 可以转换为新的二进制存储结构。

执行命令：

```powershell
bun run build --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

预期结果：

- 命令正常结束。
- 输出 `Range Strata Binary build completed`。
- `range-db/binary-smoke/` 下生成：

```text
meta.db
ranges_default_6max_100BB.idx
ranges_default_6max_100BB.bin
```

## 用例 2.1：运行 TypeScript 类型检查

测试目标：

验证项目所有 TypeScript 文件可以通过 `tsc --noEmit` 类型检查。

执行命令：

```powershell
bun run typecheck
```

预期结果：

- 命令正常结束。
- 没有 TypeScript 类型错误。

## 用例 2.2：运行 lint 检查

测试目标：

验证项目代码可以通过 ESLint 静态检查。

执行命令：

```powershell
bun run lint
```

预期结果：

- 命令正常结束。
- 没有 lint error。

## 用例 2.3：运行完整质量检查

测试目标：

验证 `typecheck + lint + test` 可以作为提交前统一检查命令。

执行命令：

```powershell
bun run check
```

预期结果：

- TypeScript 类型检查通过。
- ESLint 检查通过。
- Bun 单元测试通过。

## 用例 2.4：运行发布前检查

测试目标：

验证 Bun 质量检查、Rust 原生插件测试和 Range Strata Binary standalone 自检可以形成发布前检查闭环。

前置条件：

已构建 `range-db/range-strata-binary`。

执行命令：

```powershell
bun run check:release
```

预期结果：

- TypeScript、ESLint、Bun 测试通过。
- Rust `cargo test` 通过。
- Range Strata Binary standalone + CRC 校验通过。

## 用例 3：查询单手牌策略

测试目标：

验证可以通过二进制库读取指定 `concrete_line_id + hand` 的策略。

前置条件：

已执行用例 2。

执行命令：

```powershell
bun run query --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

预期结果：

- 返回 JSON。
- `holeCards` 等于 `22`。
- `exists` 等于 `true`。
- `actions` 中包含 `fold`、`call`、`raise` 等 action。

## 用例 4：查询时开启 CRC 校验

测试目标：

验证读取 pack 时可以进行 CRC32C 校验。

执行命令：

```powershell
bun run query --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22 --verify-checksum
```

预期结果：

- 查询成功。
- 没有出现 `CRC32C mismatch` 错误。

## 用例 5：构建指定维度

测试目标：

验证 `--dimension` 参数可以限制只构建某个维度。

执行命令：

```powershell
bun run build --source range-db/range.db --out range-db/binary-test-8max --dimension default_8max_100BB --max-packs 2 --overwrite
```

预期结果：

- 只生成 `ranges_default_8max_100BB.idx` 和 `ranges_default_8max_100BB.bin`。
- 不应生成其他维度的 `ranges_*.idx` / `ranges_*.bin` 文件。

## 用例 6：重复构建时覆盖输出

测试目标：

验证已有输出目录时，带 `--overwrite` 可以重新生成。

执行命令：

```powershell
bun run build --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

预期结果：

- 命令正常完成。
- 旧的 `meta.db`、`ranges_default_6max_100BB.idx` 和 `ranges_default_6max_100BB.bin` 被重新生成。

## 用例 7：重复构建时不允许覆盖

测试目标：

验证已有输出时，不带 `--overwrite` 会阻止覆盖，避免误删生成物。

执行命令：

```powershell
bun run build --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3
```

预期结果：

- 命令失败。
- 错误信息包含 `Output meta DB already exists`。

## 用例 8：非法手牌输入

测试目标：

验证查询非法手牌时会返回明确错误。

执行命令：

```powershell
bun run query --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand XX
```

预期结果：

- 命令失败。
- 错误信息包含 `Unknown hole cards: XX`。

## 用例 9：不存在的 concrete line

测试目标：

验证查询不存在的 `concrete_line_id` 时返回空结果。

执行命令：

```powershell
bun run query --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 999999999 --hand 22
```

预期结果：

```json
null
```

## 用例 10：二进制文件缺失

测试目标：

验证 `meta.db` 存在但 `ranges_*.idx` / `ranges_*.bin` 缺失时，查询会报出文件读取错误。

操作步骤：

1. 复制 `range-db/binary-smoke/meta.db` 到临时目录。
2. 不复制 `ranges_default_6max_100BB.idx` 和 `ranges_default_6max_100BB.bin`。
3. 执行查询命令。

执行命令示例：

```powershell
bun run query --dir range-db/binary-missing-bin --meta range-db/binary-missing-bin/meta.db --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

预期结果：

- 命令失败。
- 错误与缺失的 `.bin` 文件路径有关。

## 用例 11：pack 中所有手牌查询

测试目标：

验证 `RangeStrataQueryService.getHandsByAction()` 不传 `actionNames` 时可以返回 pack 中所有手牌。

示例代码：

```ts
import { RangeStrataQueryService } from "../src/range-strata-binary/query/service";

const service = new RangeStrataQueryService("range-db/binary-smoke/meta.db", "range-db/binary-smoke");

const result = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
});

console.log(result.length);
await service.close();
```

预期结果：

- 返回 `string[]`（holeCards 数组）。
- 数组长度大于 0。

## 用例 12：按 action 筛选手牌

测试目标：

验证 `getHandsByAction()` 可以按 action 和最小频率筛选手牌。

示例代码：

```ts
const raiseHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionNames: ["raise"],
  minFrequency: 0.1,
});
```

预期结果：

- 返回 `string[]`（holeCards 数组）。
- 所有返回手牌的 raise 频率都大于 `0.1`。

## 用例 13：Float32 bit-exact 精度校验

测试目标：

验证新二进制格式使用 Float32 后，只存在 IEEE754 Float32 正确舍入带来的不可避免量化损失，不存在额外实现损失。

测试方式：

1. 从旧表读取某个 `concrete_line_id + hole_cards + action_name`。
2. 从新二进制库读取同一项。
3. 对 `frequency` 和非 null `hand_ev` 计算 `Math.fround(source)`。
4. 比较 decoded 值与 `Math.fround(source)` 的 Float32 bit pattern。
5. 对 null `hand_ev`，校验 decoded 仍为 null。

预期结果：

```text
decoded_frequency === Math.fround(old_frequency)
float32Bits(decoded_frequency) === float32Bits(old_frequency)

decoded_hand_ev === Math.fround(old_hand_ev)  // old_hand_ev 非 null 时
decoded_hand_ev === null                     // old_hand_ev 为 null 时
```

## 用例 14：action 缺失与 frequency 为 0 的区分

测试目标：

验证 `action_masks` 可以区分 action 缺失和 action 存在但 frequency 为 0。

测试方式：

- 构造或寻找一条数据，其中某手牌缺少某个 action。
- 读取 pack 后检查该 action 的 `exists`。

预期结果：

- action 缺失时，`exists` 为 `false`。
- action 存在但 `frequency = 0` 时，`exists` 为 `true`。

## 用例 15：完整构建全部维度

测试目标：

验证可以从当前旧库构建所有维度的二进制文件。

执行命令：

```powershell
bun run build --source range-db/range.db --out range-db/range-strata-binary --overwrite
```

预期结果：

- 生成 `meta.db`。
- 生成所有维度的 `ranges_*.idx` 和 `ranges_*.bin`。
- 查询任意已存在维度时可以正常返回策略。

## 用例 16：OS 冷启动 benchmark 覆盖全部维度

测试目标：

验证 cold-start benchmark 默认读取 `manifest.json` 中全部成功维度，生产产物应覆盖 9 个维度，并为每个维度执行相同次数的 fresh process 首查。

执行命令：

```powershell
bun run benchmark:cold `
  --source range-db/range.db `
  --dir range-db/range-strata-binary `
  --runs 10 `
  --concrete-line-id 1 `
  --hand AA `
  --mode process-cold
```

预期结果：

- `reports/benchmark-cold-start.json` 与 `reports/benchmark-cold-start.md` 写出。
- `aggregate.dimensions = 9`。
- `aggregate.runs = 90`。
- `aggregate.errorCount = 0`。
- 每个维度都有 `runs = 10`，并记录 open+first-query p50/p95、进程总耗时 p50/p95、RSS delta。

## 自动化覆盖状态

已自动化覆盖：

1. 用例 1：`bun test` 覆盖二进制 codec、CRC、header、range pack、idx reader/writer。
2. 用例 2：`tests/range-strata-compile.test.ts` 覆盖小样本构建与生成物结构。
3. 用例 3、4、8、9、10：`tests/range-strata-compile.test.ts` 覆盖单手牌查询、CRC 校验、非法手牌、不存在 concrete line、缺失二进制文件。
4. 用例 11、12：`tests/range-strata-query-service.test.ts` 覆盖 `getHandsByAction()` 全量返回、按 action 筛选和 `minFrequency` 边界。
5. 用例 13：`tests/float32-precision.test.ts` 和 `tests/range-strata-verify.test.ts` 覆盖 Float32 bit-exact 策略与 source cross 校验。
6. 用例 14：`tests/binary-codec.test.ts` 覆盖 action mask 语义，`tests/range-strata-query-service.test.ts` 覆盖 `handEV=null` 与 `handEV=0` 区分。
7. 用例 16：`tests/cold-start-benchmark.test.ts` 覆盖默认读取 manifest 中全部成功维度、维度过滤和失败维度隔离。

仍建议人工或发布前验证：

1. 用例 15：基于真实 `range-db/range.db` 的全量构建。
2. 用例 16：生产产物应覆盖 9 个维度的完整 cold-start benchmark。
