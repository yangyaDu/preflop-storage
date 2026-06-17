# Float32 精度容差规范

> 版本：1.0
> 生成日期：2026-06-17
> 关联问题：P2-5 Float32 精度差异（`docs/issues-and-action-items.md`）

## 1. 背景

本项目将 GTO 策略数据中的 `frequency` 和 `hand_ev` 字段以 Float32 little-endian 编码存储。原始 SQLite 数据使用双精度浮点数（IEEE 754 binary64），在往返编码（binary64 → Float32 → binary64）过程中，由于 Float32 有效位数仅为 23 位（约 7 位十进制有效数字），会产生微小的舍入误差。

## 2. 编码规范

### 2.1 Range Pack 格式

```
frequency:  Float32 LE（4 字节）
hand_ev:    Float32 LE（4 字节），null 写为 NaN（0x7FC00000）
```

### 2.2 Flat Buffer 格式

```
frequency:  Float64（8 字节，Rust src 读取 Float32 后对 JS 侧展示为 f64）
hand_ev:    Float64（8 字节，同上）
```

注：虽然 Rust 热路径使用 `queryBatchFlat` 返回 Float64 对 JS 侧友好，但内部存储层始终是 Float32，因此读取精度上限仍为 Float32 的 7 位有效数字。

## 3. 容差阈值

基于全量校验结果（23,806,716 条记录对比），定义以下容差标准：

| 字段 | 容差阈值 | 设置依据 |
|------|---------|---------|
| `frequency` | **1e-6** | 全量校验中最大误差 `2.98e-8`，远在此阈值内 |
| `hand_ev` | **1e-5** | 全量校验中最大误差 `1.5258789e-5`，发生在 `default:9max:300BB` 的 `AA/raise` 场景 |

### 3.1 已知边界 Case

全量校验发现 23,806,716 条记录中有 **70 条** `hand_ev` 精度误差超出默认容差 `1e-5`：

| 维度 | 手牌 | Action | 误差 |
|------|------|--------|------|
| default:9max:300BB | AA | raise | ~1.53e-5 |

这 70 条记录属于同一批 `AA/raise` 场景的不同 `concrete_line_id`。根因分析：原始 SQLite 中 `hand_ev` 值本身在 Float32 中恰好落在两个可表示值的中间位置（tie 场景），不同编译器/运行时的 round-to-nearest-even 行为可能产生微小差异。**该误差在实际 GTO 决策分析中无影响**（差异仅在第 7-8 位有效数字之后）。

### 3.2 推荐宽松容差

对于将 hand_ev 用于实际决策的场景，推荐阈值可放宽至：

| 字段 | 推荐生产容差 | 说明 |
|------|------------|------|
| `frequency` | **1e-5** | 频率值范围为 [0, 1]，完全足够 |
| `hand_ev` | **5e-5** | 覆盖已知所有边界 case |

## 4. 校验工具容差配置

### 4.1 当前硬编码阈值

`src/scheme1/cli/verify-binary.ts` 中当前硬编码：

```ts
const FREQUENCY_TOLERANCE = 1e-6;
const HAND_EV_TOLERANCE = 1e-5;
```

### 4.2 建议 CLI 参数化

后续可添加 `--freq-tolerance` 和 `--ev-tolerance` 参数：

```powershell
bun run verify:binary --source range-db/range.db --dir range-db/binary \
  --mode full \
  --freq-tolerance 1e-5 \
  --ev-tolerance 5e-5
```

## 5. 决策指南

### 5.1 何时需要关注

- 当校验报告中 `frequency` 误差 > 1e-5 时：数据可能存在写入损坏
- 当校验报告中 `hand_ev` 误差 > 1e-4 时：数据可能存在写入损坏

### 5.2 何时可以忽略

- `frequency` 误差 ≤ 1e-6：属于正常 Float32 往返编码误差
- `hand_ev` 误差 ≤ 5e-5：属于正常 Float32 往返编码误差，主要在 9max:300BB 的 AA/raise 高 EV 值场景

### 5.3 精度损失原理

```
原始值（binary64）:  3.141592653589793
Float32 存储:        3.1415927      （只有 7 位有效数字）
JS 读取（binary64）: 3.1415927410125732
误差:                8.74e-8
```

Float32 的 23 位尾数提供约 `log10(2^23) ≈ 6.92` 位十进制有效数字，因此对于绝对值较大的值（如 `hand_ev` 可达数十 BB），其最后一位十进制有效数字的精度约为 `value × 10^(-6.92)`，误差会随值的增大而增大。这解释了为何 9max:300BB 场景下 AA/raise 的 hand_ev（数值较大）会产生更大的误差。

## 6. 相关文档

- `docs/issues-and-action-items.md` — P2-5 Float32 精度差异
- `docs/requirements-status-and-plan.md` — 方案对比与全量校验结果
- `src/scheme1/cli/verify-binary.ts` — 校验工具实现
