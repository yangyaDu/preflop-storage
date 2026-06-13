# 二进制 Benchmark 报告

生成时间：2026-06-13T05:19:22.401Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary`
- meta.db：`range-db\binary\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB
- workload seed：42
- 总迭代：700
- 总耗时：476.19 ms
- 综合 QPS：1470.01
- 错误数：0
- 返回 action 总数：14,686
- RSS 变化：62.01 MB
- heap used 变化：21.95 MB
- 冷启动首查：20.94 ms，返回 action 数：4

## Workload

- 单手牌查询：500
- 批量查询：200
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 500 | 0.271 ms | 0.295 ms | 0.687 ms | 0.853 ms | 0.961 ms | 3690.08 | 0 |
| batch-hand-strategy | 200 | 1.702 ms | 1.721 ms | 3.570 ms | 4.034 ms | 4.857 ms | 587.04 | 0 |

## 内存

- before RSS：182.91 MB
- after RSS：244.92 MB
- before heap used：3.13 MB
- after heap used：25.08 MB

## 说明

- Cold start includes opening meta.db/ranges file and running the first hand query, but it does not flush the operating-system file cache.
- Hot measurements run after the service is opened; pack cache behavior is controlled by --pack-cache-size.
- Result counts sum decoded action entries so work is consumed rather than only requested.
