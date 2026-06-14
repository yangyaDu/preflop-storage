# SQLite Benchmark 报告

生成时间：2026-06-14T15:29:49.331Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：40
- 总耗时：32.68 ms
- 综合 QPS：1223.93
- 错误数：0
- 返回 action 总数：2,846
- RSS 变化：1.44 MB
- heap used 变化：0 B
- 冷启动首查：14.23 ms，返回 action 数：4

## Workload

- workload 来源：generated
- 单手牌查询：10
- 批量查询：5
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 10 | 0.013 ms | 0.012 ms | 0.016 ms | 0.016 ms | 0.016 ms | 75471.70 | 0 |
| batch-hand-strategy | 5 | 0.036 ms | 0.025 ms | 0.068 ms | 0.075 ms | 0.076 ms | 27397.26 | 0 |
| batch-size-1 | 5 | 0.035 ms | 0.036 ms | 0.049 ms | 0.051 ms | 0.051 ms | 28506.27 | 0 |
| batch-size-5 | 5 | 0.083 ms | 0.084 ms | 0.091 ms | 0.091 ms | 0.091 ms | 12027.90 | 0 |
| batch-size-10 | 5 | 0.302 ms | 0.247 ms | 0.475 ms | 0.512 ms | 0.521 ms | 3313.45 | 0 |
| batch-size-50 | 5 | 1.856 ms | 1.722 ms | 2.254 ms | 2.349 ms | 2.372 ms | 538.73 | 0 |
| batch-size-100 | 5 | 4.197 ms | 4.208 ms | 4.877 ms | 4.961 ms | 4.982 ms | 238.26 | 0 |

## 内存

- before RSS：146.52 MB
- after RSS：147.96 MB
- before heap used：238.95 KB
- after heap used：238.95 KB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
