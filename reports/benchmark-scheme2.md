# 二进制 Benchmark 报告

生成时间：2026-06-16T15:12:21.042Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：275.82 ms
- 综合 QPS：8701.17
- 错误数：0
- 返回 action 总数：141,985
- RSS 变化：225.35 MB
- heap used 变化：20.08 MB
- 冷启动首查：1.21 s，返回 action 数：4

## Workload

- workload 来源：generated
- workload mode：random
- 单手牌查询：1,000
- 批量查询：200
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 1,000 | 0.011 ms | 0.009 ms | 0.021 ms | 0.047 ms | 0.114 ms | 92620.04 | 0 |
| batch-hand-strategy | 200 | 0.148 ms | 0.133 ms | 0.219 ms | 0.385 ms | 0.481 ms | 6774.33 | 0 |
| batch-size-1 | 200 | 0.011 ms | 0.011 ms | 0.019 ms | 0.034 ms | 0.038 ms | 87604.03 | 0 |
| batch-size-5 | 200 | 0.040 ms | 0.034 ms | 0.070 ms | 0.101 ms | 0.133 ms | 24826.83 | 0 |
| batch-size-10 | 200 | 0.069 ms | 0.064 ms | 0.119 ms | 0.173 ms | 0.258 ms | 14496.64 | 0 |
| batch-size-20 | 200 | 0.159 ms | 0.096 ms | 0.193 ms | 0.389 ms | 8.987 ms | 6283.12 | 0 |
| batch-size-50 | 200 | 0.319 ms | 0.300 ms | 0.449 ms | 0.616 ms | 0.723 ms | 3135.27 | 0 |
| batch-size-100 | 200 | 0.579 ms | 0.505 ms | 0.892 ms | 1.072 ms | 3.624 ms | 1727.89 | 0 |

## 内存

- before RSS：198.34 MB
- after RSS：423.68 MB
- before heap used：633.39 KB
- after heap used：20.69 MB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
