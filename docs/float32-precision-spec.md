# Float32 精度策略

> 版本：2.0
> 更新日期：2026-06-20
> 关联问题：P2-5 Float32 精度差异（`docs/issues-and-action-items.md`）

## 1. 当前结论

当前项目继续使用 Float32 存储 `frequency` 和 `hand_ev`，但校验标准不再以固定绝对容差为主。

新的硬标准是：

```text
decoded value 必须等于 source value 按 IEEE754 Float32 正确舍入后的值。
```

也就是：

```ts
expected = Math.fround(source)
actual = decoded
```

只有 `actual` 与 `expected` 完全一致，才视为通过。这样只允许 Float32 本身不可避免的量化损失，不允许编码、解码、字节序、Rust/JS 转换或验证逻辑引入额外损失。

## 2. 存储格式

### Range Pack

```text
frequency: Float32 little-endian
hand_ev:   Float32 little-endian，null 写为 canonical NaN
```

### 查询返回

Rust / JS 查询层会把 Float32 读取结果以 JS `number` 暴露。JS `number` 是 Float64，但它承载的值必须仍然是原始 Float32 可精确表示的值。

## 3. 校验原则

### 3.1 数值字段

对 `frequency` 和非 null `hand_ev`：

```text
expectedBits = float32Bits(source)
actualBits = float32Bits(actual)
expectedValue = Math.fround(source)

通过条件：
  actualBits == expectedBits
  且 Object.is(actual, expectedValue)
```

说明：

- `actualBits == expectedBits` 确认二进制 Float32 表示一致。
- `Object.is()` 保留 `-0` 和 `+0` 的差异。
- 即使 `abs(source - actual) <= 1e-6`，只要落到不同 Float32 表示，也必须失败。

### 3.2 Nullable `hand_ev`

```text
source null + decoded null => pass
source null + decoded number => fail
source number + decoded null => fail
source number + decoded number => 进入 Float32 bit-exact 校验
```

### 3.3 非有限数

正常 source DB 不应包含 `NaN`、`Infinity` 或 `-Infinity`。如果出现，校验应作为失败记录，而不是混入容差逻辑。

## 4. 报告指标

Cross verify 报告现在输出 `precision` 段，分别统计 `frequency` 和 `handEv`：

- `checkedValues`：参与数值校验的数量
- `nullValues`：null 值数量，仅 `handEv` 常见
- `bitExactValues`：通过 bit-exact 校验的数量
- `mismatchValues`：未通过 bit-exact 校验的数量
- `maxQuantizationAbsError`：`abs(source - Math.fround(source))` 最大值
- `maxQuantizationRelativeError`：相对量化误差最大值
- `maxImplementationAbsError`：`abs(decoded - Math.fround(source))` 最大值
- `p95QuantizationAbsError` / `p99QuantizationAbsError`：量化误差分位估计
- `topQuantizationErrors`：量化误差最大的样本

其中：

```text
quantization error = Float32 格式本身造成的不可避免损失
implementation error = 实现额外引入的损失
```

验收目标：

```text
mismatchValues == 0
maxImplementationAbsError == 0
```

`maxQuantizationAbsError` 可以大于 0，这是 Float32 本身的正常量化结果。

## 5. 历史观测值

旧版本文档曾使用固定阈值：

| 字段 | 旧阈值 | 说明 |
| --- | --- | --- |
| `frequency` | `1e-6` | 历史全量最大误差约 `2.98e-8` |
| `hand_ev` | `1e-5` | 历史发现约 70 条记录略超此阈值，最大约 `1.5258789e-5` |

这些值现在只作为历史观测和业务感知参考，不再作为核心正确性标准。

如果某个值的 Float32 量化误差超过旧阈值，但 decoded 精确等于 `Math.fround(source)`，则视为格式层正确，只在报告中记录量化误差。

## 6. 后续扩展

如果未来业务确认 Float32 量化误差仍不可接受，优先考虑：

```text
Float32 主存储 + 少量 exception delta 表
```

即：

- 默认仍使用 Float32，保持当前体积优势。
- 只对超过业务阈值的极少数记录额外保存修正值或 Float64。
- 查询时先读 Float32，再按 exception 表覆盖。

这比全量改为 Float64 更节省空间，也能把精度损失压到最小。

## 7. 相关实现

- `src/precision/float32.ts`：Float32 bit-exact 校验、bits 转换、量化误差统计
- `src/scheme2/verify/checks/source-cross.ts`：source DB 与 Scheme2 产物的 bit-exact cross verify
- `tests/float32-precision.test.ts`：Float32 精度工具测试
- `tests/scheme2-verify.test.ts`：cross verify 精度边界测试
