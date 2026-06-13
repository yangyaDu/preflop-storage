# SQLite Benchmark 报告

生成时间：2026-06-13T06:50:25.956Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：300
- 总耗时：128.97 ms
- 综合 QPS：2326.18
- 错误数：0
- 返回 action 总数：7,422
- RSS 变化：4.55 MB
- heap used 变化：0 B
- 冷启动首查：17.80 ms，返回 action 数：3

## Workload

- 单手牌查询：200
- 批量查询：100
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 200 | 0.092 ms | N/A | N/A | N/A | N/A | 10849.34 | 0 |
| batch-hand-strategy | 100 | 1.105 ms | N/A | N/A | N/A | N/A | 904.71 | 0 |

## 内存

- before RSS：142.06 MB
- after RSS：146.61 MB
- before heap used：238.95 KB
- after heap used：238.95 KB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
