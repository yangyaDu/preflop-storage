# SQLite Benchmark 报告

生成时间：2026-06-12T17:57:30.166Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：1,200
- 总耗时：246.10 ms
- 综合 QPS：4876.13
- 错误数：0
- 返回 action 总数：16,869
- RSS 变化：6.94 MB
- heap used 变化：0 B
- 冷启动首查：15.02 ms，返回 action 数：3

## Workload

- 单手牌查询：1,000
- 批量查询：200
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 1,000 | 0.059 ms | 0.054 ms | 0.105 ms | 0.154 ms | 0.430 ms | 16798.93 | 0 |
| batch-hand-strategy | 200 | 0.932 ms | 0.876 ms | 1.279 ms | 1.570 ms | 2.057 ms | 1071.99 | 0 |

## 内存

- before RSS：148.75 MB
- after RSS：155.69 MB
- before heap used：238.95 KB
- after heap used：238.95 KB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
