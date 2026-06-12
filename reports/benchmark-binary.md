# 二进制 Benchmark 报告

生成时间：2026-06-12T12:57:06.285Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary`
- meta.db：`range-db\binary\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：330
- 总耗时：9.01 s
- 综合 QPS：36.63
- 错误数：0
- 返回 action 总数：26,650
- RSS 变化：103.48 MB
- heap used 变化：31.21 MB
- 冷启动首查：27.85 ms，返回 action 数：3

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
| hand-strategy | 200 | 1.684 ms | 1.388 ms | 3.147 ms | 11.19 ms | 12.21 ms | 593.29 | 0 |
| full-range | 50 | 1.405 ms | 1.273 ms | 2.363 ms | 12.06 ms | 12.06 ms | 711.54 | 0 |
| drill-random | 30 | 254.78 ms | 84.18 ms | 1.57 s | 2.14 s | 2.14 s | 3.92 | 0 |
| batch-hand-strategy | 50 | 19.16 ms | 22.33 ms | 28.26 ms | 44.66 ms | 44.66 ms | 52.19 | 0 |

## 内存

- before RSS：174.02 MB
- after RSS：277.50 MB
- before heap used：1.15 MB
- after heap used：32.36 MB

## 说明

- Cold start includes opening meta.db/ranges file and running the first hand query, but it does not flush the operating-system file cache.
- Hot measurements run after the service is opened; pack cache behavior is controlled by --pack-cache-size.
- Result counts sum decoded action entries so work is consumed rather than only requested.
