# 二进制 Benchmark 报告

生成时间：2026-06-15T15:20:23.824Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：11.60 s
- 综合 QPS：206.88
- 错误数：0
- 返回 action 总数：141,985
- RSS 变化：193.33 MB
- heap used 变化：8.11 MB
- 冷启动首查：3.526 ms，返回 action 数：4

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
| hand-strategy | 1,000 | 0.275 ms | 0.285 ms | 0.525 ms | 0.720 ms | 1.177 ms | 3637.62 | 0 |
| batch-hand-strategy | 200 | 3.011 ms | 3.175 ms | 5.365 ms | 5.966 ms | 6.777 ms | 332.08 | 0 |
| batch-size-1 | 200 | 8.937 ms | 8.376 ms | 16.51 ms | 21.18 ms | 29.38 ms | 111.89 | 0 |
| batch-size-5 | 200 | 8.937 ms | 8.372 ms | 16.62 ms | 21.18 ms | 29.43 ms | 111.89 | 0 |
| batch-size-10 | 200 | 8.937 ms | 8.654 ms | 16.82 ms | 20.87 ms | 30.21 ms | 111.89 | 0 |
| batch-size-20 | 200 | 8.937 ms | 8.579 ms | 17.32 ms | 20.52 ms | 30.32 ms | 111.89 | 0 |
| batch-size-50 | 200 | 8.936 ms | 8.549 ms | 17.35 ms | 20.53 ms | 30.31 ms | 111.90 | 0 |
| batch-size-100 | 200 | 8.934 ms | 8.313 ms | 16.60 ms | 20.22 ms | 27.24 ms | 111.93 | 0 |

## 内存

- before RSS：190.81 MB
- after RSS：384.14 MB
- before heap used：633.39 KB
- after heap used：8.73 MB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
