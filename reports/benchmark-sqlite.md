# SQLite Benchmark 报告

生成时间：2026-06-16T15:15:17.180Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：1.71 s
- 综合 QPS：1401.13
- 错误数：0
- 返回 action 总数：141,985
- RSS 变化：31.69 MB
- heap used 变化：3.09 MB
- 冷启动首查：14.34 ms，返回 action 数：4

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
| hand-strategy | 1,000 | 0.047 ms | 0.038 ms | 0.082 ms | 0.240 ms | 0.492 ms | 21495.35 | 0 |
| batch-hand-strategy | 200 | 0.861 ms | 0.786 ms | 1.367 ms | 1.648 ms | 2.117 ms | 1161.32 | 0 |
| batch-size-1 | 200 | 0.041 ms | 0.034 ms | 0.073 ms | 0.133 ms | 0.309 ms | 24162.18 | 0 |
| batch-size-5 | 200 | 0.200 ms | 0.169 ms | 0.431 ms | 0.535 ms | 0.593 ms | 5005.06 | 0 |
| batch-size-10 | 200 | 0.406 ms | 0.332 ms | 0.738 ms | 1.073 ms | 1.224 ms | 2462.99 | 0 |
| batch-size-20 | 200 | 0.772 ms | 0.683 ms | 1.343 ms | 1.655 ms | 1.944 ms | 1295.32 | 0 |
| batch-size-50 | 200 | 2.171 ms | 2.039 ms | 3.284 ms | 3.758 ms | 4.447 ms | 460.54 | 0 |
| batch-size-100 | 200 | 3.880 ms | 3.682 ms | 5.418 ms | 6.032 ms | 7.750 ms | 257.71 | 0 |

## 内存

- before RSS：177.54 MB
- after RSS：209.23 MB
- before heap used：238.95 KB
- after heap used：3.33 MB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
