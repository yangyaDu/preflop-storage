# 二进制 Benchmark 报告

生成时间：2026-06-15T15:50:41.352Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：226.29 ms
- 综合 QPS：10605.82
- 错误数：0
- 返回 action 总数：135,531
- RSS 变化：105.35 MB
- heap used 变化：12.49 MB
- 冷启动首查：56.82 ms，返回 action 数：4

## Workload

- workload 来源：generated
- workload mode：abstract-local
- 单手牌查询：1,000
- 批量查询：200
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 1,000 | 0.018 ms | 0.011 ms | 0.034 ms | 0.204 ms | 0.269 ms | 56083.05 | 0 |
| batch-hand-strategy | 200 | 0.121 ms | 0.099 ms | 0.264 ms | 0.426 ms | 0.547 ms | 8292.49 | 0 |
| batch-size-1 | 200 | 0.014 ms | 0.010 ms | 0.022 ms | 0.046 ms | 0.258 ms | 72827.91 | 0 |
| batch-size-5 | 200 | 0.090 ms | 0.031 ms | 0.068 ms | 0.481 ms | 8.345 ms | 11072.97 | 0 |
| batch-size-10 | 200 | 0.046 ms | 0.041 ms | 0.065 ms | 0.108 ms | 0.237 ms | 21893.10 | 0 |
| batch-size-20 | 200 | 0.065 ms | 0.063 ms | 0.085 ms | 0.102 ms | 0.142 ms | 15423.53 | 0 |
| batch-size-50 | 200 | 0.215 ms | 0.198 ms | 0.324 ms | 0.587 ms | 0.743 ms | 4658.82 | 0 |
| batch-size-100 | 200 | 0.493 ms | 0.400 ms | 0.761 ms | 1.133 ms | 7.446 ms | 2030.42 | 0 |

## 内存

- before RSS：231.09 MB
- after RSS：336.44 MB
- before heap used：19.17 MB
- after heap used：31.66 MB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
- Action schemas are prewarmed into the Scheme2QueryService cache before hot measurements.
