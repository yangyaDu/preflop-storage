# 二进制 Benchmark 报告

生成时间：2026-06-12T17:57:35.182Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary`
- meta.db：`range-db\binary\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：1,200
- 总耗时：1.07 s
- 综合 QPS：1119.70
- 错误数：0
- 返回 action 总数：16,869
- RSS 变化：261.53 MB
- heap used 变化：182.24 MB
- 冷启动首查：230.33 ms，返回 action 数：3

## Workload

- 单手牌查询：1,000
- 批量查询：200
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 1,000 | 0.362 ms | 0.431 ms | 0.611 ms | 0.901 ms | 2.186 ms | 2758.93 | 0 |
| batch-hand-strategy | 200 | 3.545 ms | 3.731 ms | 6.100 ms | 6.777 ms | 7.588 ms | 281.99 | 0 |

## 内存

- before RSS：353.58 MB
- after RSS：615.11 MB
- before heap used：139.89 MB
- after heap used：322.13 MB

## 说明

- Cold start includes opening meta.db/ranges file and running the first hand query, but it does not flush the operating-system file cache.
- Hot measurements run after the service is opened; pack cache behavior is controlled by --pack-cache-size.
- Result counts sum decoded action entries so work is consumed rather than only requested.
