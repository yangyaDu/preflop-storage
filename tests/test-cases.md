# Preflop Storage 测试用例

本文档用于记录 Preflop Storage 项目的核心测试用例，覆盖二进制格式、旧 SQLite 转换、查询读取、配置参数和异常场景。

## 测试范围

主要测试对象：

- `src/binary/`：二进制 header、action schema、range pack、CRC32C。
- `src/scheme2/importer/`：旧 SQLite 到 `meta.db + .idx + .bin` 的主构建流程。
- `src/scheme2/query/`：Scheme2 + Rust 热路径查询服务。
- `src/scheme2/cli/`：Scheme2 构建、查询、校验和 benchmark 命令。

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
bun run build:scheme2 --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

预期结果：

- 命令正常结束。
- 输出 `scheme2 binary build completed`。
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

验证 Bun 质量检查、Rust 原生插件测试和 Scheme2 standalone 自检可以形成发布前检查闭环。

前置条件：

已构建 `range-db/binary-scheme2`。

执行命令：

```powershell
bun run check:release
```

预期结果：

- TypeScript、ESLint、Bun 测试通过。
- Rust `cargo test` 通过。
- Scheme2 standalone + CRC 校验通过。

## 用例 3：查询单手牌策略

测试目标：

验证可以通过二进制库读取指定 `concrete_line_id + hand` 的策略。

前置条件：

已执行用例 2。

执行命令：

```powershell
bun run query:scheme2 --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
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
bun run query:scheme2 --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22 --verify-checksum
```

预期结果：

- 查询成功。
- 没有出现 `CRC32C mismatch` 错误。

## 用例 5：构建指定维度

测试目标：

验证 `--dimension` 参数可以限制只构建某个维度。

执行命令：

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-test-8max --dimension default_8max_100BB --max-packs 2 --overwrite
```

预期结果：

- 只生成 `ranges_default_8max_100BB.idx` 和 `ranges_default_8max_100BB.bin`。
- 不应生成其他维度的 `ranges_*.idx` / `ranges_*.bin` 文件。

## 用例 6：重复构建时覆盖输出

测试目标：

验证已有输出目录时，带 `--overwrite` 可以重新生成。

执行命令：

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3 --overwrite
```

预期结果：

- 命令正常完成。
- 旧的 `meta.db`、`ranges_default_6max_100BB.idx` 和 `ranges_default_6max_100BB.bin` 被重新生成。

## 用例 7：重复构建时不允许覆盖

测试目标：

验证已有输出时，不带 `--overwrite` 会阻止覆盖，避免误删生成物。

执行命令：

```powershell
bun run build:scheme2 --source range-db/range.db --out range-db/binary-smoke --dimension default:6:100 --max-packs 3
```

预期结果：

- 命令失败。
- 错误信息包含 `Output meta DB already exists`。

## 用例 8：非法手牌输入

测试目标：

验证查询非法手牌时会返回明确错误。

执行命令：

```powershell
bun run query:scheme2 --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand XX
```

预期结果：

- 命令失败。
- 错误信息包含 `Unknown hole cards: XX`。

## 用例 9：不存在的 concrete line

测试目标：

验证查询不存在的 `concrete_line_id` 时返回空结果。

执行命令：

```powershell
bun run query:scheme2 --dir range-db/binary-smoke --player-count 6 --depth-bb 100 --concrete-line-id 999999999 --hand 22
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
bun run query:scheme2 --dir range-db/binary-missing-bin --meta range-db/binary-missing-bin/meta.db --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand 22
```

预期结果：

- 命令失败。
- 错误与缺失的 `.bin` 文件路径有关。

## 用例 11：pack 中所有手牌查询

测试目标：

验证 `Scheme2QueryService.getHandsByAction()` 不传 `actionNames` 时可以返回 pack 中所有手牌。

示例代码：

```ts
import { Scheme2QueryService } from "../src/scheme2/query/query-service";

const service = new Scheme2QueryService("range-db/binary-smoke/meta.db", "range-db/binary-smoke");

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

## 用例 13：Float32 精度差异

测试目标：

验证新二进制格式使用 Float32 后，与旧 SQLite REAL 之间只存在可接受的微小误差。

测试方式：

1. 从旧表读取某个 `concrete_line_id + hole_cards + action_name`。
2. 从新二进制库读取同一项。
3. 比较 `frequency` 和 `hand_ev`。

预期结果：

```text
abs(old_frequency - new_frequency) <= 1e-6
abs(old_hand_ev - new_hand_ev) <= 1e-5
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
bun run build:scheme2 --source range-db/range.db --out range-db/binary-scheme2 --overwrite
```

预期结果：

- 生成 `meta.db`。
- 生成所有维度的 `ranges_*.idx` 和 `ranges_*.bin`。
- 查询任意已存在维度时可以正常返回策略。

## 建议自动化优先级

优先自动化：

1. 用例 1：单元测试。
2. 用例 2：小样本构建。
3. 用例 3：单手牌查询。
4. 用例 4：CRC 校验。
5. 用例 8：非法手牌输入。
6. 用例 9：不存在的 concrete line。

人工或发布前验证：

1. 用例 13：旧库与新库精度对比。
2. 用例 14：action mask 语义。
3. 用例 15：全量构建。
