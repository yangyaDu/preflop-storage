# 二进制 Benchmark 报告

生成时间：2026-06-15T15:50:26.880Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：1.32 s
- 综合 QPS：1824.61
- 错误数：0
- 返回 action 总数：141,985
- RSS 变化：211.43 MB
- heap used 变化：13.02 MB
- 冷启动首查：89.24 ms，返回 action 数：4

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
| hand-strategy | 1,000 | 0.238 ms | 0.228 ms | 0.463 ms | 0.700 ms | 1.628 ms | 4203.31 | 0 |
| batch-hand-strategy | 200 | 2.165 ms | 2.214 ms | 3.690 ms | 4.655 ms | 6.105 ms | 461.96 | 0 |
| batch-size-1 | 200 | 0.068 ms | 0.017 ms | 0.274 ms | 0.373 ms | 0.935 ms | 14750.24 | 0 |
| batch-size-5 | 200 | 0.392 ms | 0.286 ms | 0.736 ms | 1.074 ms | 12.65 ms | 2549.04 | 0 |
| batch-size-10 | 200 | 0.446 ms | 0.410 ms | 0.944 ms | 1.279 ms | 2.013 ms | 2244.01 | 0 |
| batch-size-20 | 200 | 0.095 ms | 0.084 ms | 0.159 ms | 0.204 ms | 0.414 ms | 10500.51 | 0 |
| batch-size-50 | 200 | 1.149 ms | 1.053 ms | 2.310 ms | 3.589 ms | 3.731 ms | 870.18 | 0 |
| batch-size-100 | 200 | 1.072 ms | 0.974 ms | 1.806 ms | 2.623 ms | 7.949 ms | 932.52 | 0 |

## 内存

- before RSS：228.19 MB
- after RSS：439.62 MB
- before heap used：19.43 MB
- after heap used：32.45 MB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
- Action schemas are prewarmed into the Scheme2QueryService cache before hot measurements.
