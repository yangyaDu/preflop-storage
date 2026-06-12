# SQLite Benchmark 报告

生成时间：2026-06-12T12:56:34.675Z

## 总览

- 引擎：sqlite
- 源 SQLite：`range-db/range.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：330
- 总耗时：579.13 ms
- 综合 QPS：569.82
- 错误数：0
- 返回 action 总数：26,650
- RSS 变化：24.16 MB
- heap used 变化：0 B
- 冷启动首查：15.53 ms，返回 action 数：3

## Workload

- 单手牌查询：200
- 全 range 查询：50
- drill 场景查询：30
- 批量查询：50
- batch size：20
- warmup iterations：10

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 200 | 0.059 ms | 0.044 ms | 0.148 ms | 0.255 ms | 0.332 ms | 16785.56 | 0 |
| full-range | 50 | 0.493 ms | 0.391 ms | 1.367 ms | 3.184 ms | 3.184 ms | 2027.13 | 0 |
| drill-random | 30 | 16.38 ms | 3.837 ms | 65.75 ms | 87.49 ms | 87.49 ms | 61.03 | 0 |
| batch-hand-strategy | 50 | 1.019 ms | 0.922 ms | 1.736 ms | 2.007 ms | 2.007 ms | 980.56 | 0 |

## 内存

- before RSS：113.93 MB
- after RSS：138.09 MB
- before heap used：238.95 KB
- after heap used：238.95 KB

## 说明

- Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.
- SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.
- Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.
