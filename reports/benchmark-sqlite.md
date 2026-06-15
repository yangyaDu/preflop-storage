# SQLite Benchmark 报告

生成时间：2026-06-15T15:50:11.708Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：2,400
- 总耗时：1.74 s
- 综合 QPS：1379.55
- 错误数：0
- 返回 action 总数：141,985
- RSS 变化：65.70 MB
- heap used 变化：2.92 MB
- 冷启动首查：12.57 ms，返回 action 数：4

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
| hand-strategy | 1,000 | 0.048 ms | 0.039 ms | 0.087 ms | 0.237 ms | 0.501 ms | 20733.60 | 0 |
| batch-hand-strategy | 200 | 0.865 ms | 0.779 ms | 1.375 ms | 1.687 ms | 2.151 ms | 1155.45 | 0 |
| batch-size-1 | 200 | 0.042 ms | 0.037 ms | 0.071 ms | 0.181 ms | 0.343 ms | 23818.88 | 0 |
| batch-size-5 | 200 | 0.212 ms | 0.188 ms | 0.400 ms | 0.648 ms | 0.691 ms | 4709.35 | 0 |
| batch-size-10 | 200 | 0.429 ms | 0.356 ms | 0.763 ms | 1.148 ms | 1.428 ms | 2333.02 | 0 |
| batch-size-20 | 200 | 0.849 ms | 0.736 ms | 1.319 ms | 1.830 ms | 2.083 ms | 1178.40 | 0 |
| batch-size-50 | 200 | 2.020 ms | 1.907 ms | 2.994 ms | 3.847 ms | 4.757 ms | 495.00 | 0 |
| batch-size-100 | 200 | 4.040 ms | 3.834 ms | 6.091 ms | 7.150 ms | 13.65 ms | 247.52 | 0 |

## 内存

- before RSS：143.74 MB
- after RSS：209.45 MB
- before heap used：262.90 KB
- after heap used：3.18 MB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
