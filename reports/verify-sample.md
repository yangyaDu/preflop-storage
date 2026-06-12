# 二进制一致性校验报告

生成时间：2026-06-12T06:21:36.216Z

## 总览

- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary`
- meta.db：`range-db\binary\meta.db`
- 模式：sample
- sample size：10,000
- 维度数量：9
- 校验 concrete line：9,709
- 校验旧记录数：10,000
- 成功旧记录数：10,000
- 失败旧记录数：0
- 二进制额外记录数：0
- 失败记录总数：0
- pack 读取失败数：0
- frequency 最大误差：2.9768402742824662e-8
- hand_ev 最大误差：0.00000762939453125

## 误差阈值

- action_size：0.000001
- amount_bb：0.000001
- frequency：0.000001
- hand_ev：0.00001

## 维度结果

| dimension | lines | checked old rows | success | failed old rows | extra binary rows | pack failures |
| --- | --- | --- | --- | --- | --- | --- |
| default:6max:100BB | 79 | 81 | 81 | 0 | 0 | 0 |
| default:6max:200BB | 54 | 59 | 59 | 0 | 0 | 0 |
| default:6max:300BB | 44 | 48 | 48 | 0 | 0 | 0 |
| default:8max:100BB | 164 | 167 | 167 | 0 | 0 | 0 |
| default:8max:200BB | 113 | 119 | 119 | 0 | 0 | 0 |
| default:8max:300BB | 90 | 94 | 94 | 0 | 0 | 0 |
| default:9max:100BB | 3,129 | 3,220 | 3,220 | 0 | 0 | 0 |
| default:9max:200BB | 3,935 | 4,030 | 4,030 | 0 | 0 | 0 |
| default:9max:300BB | 2,101 | 2,182 | 2,182 | 0 | 0 | 0 |

## 失败样例

未发现失败样例。

## 修复建议

- 校验通过。可以继续运行 full 模式或进入 benchmark 阶段。
