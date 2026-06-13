# 二进制 Benchmark 报告

生成时间：2026-06-13T12:30:12.254Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：15
- 总耗时：1.692 ms
- 综合 QPS：8866.30
- 错误数：0
- 返回 action 总数：370
- RSS 变化：4.14 MB
- heap used 变化：0 B
- 冷启动首查：27.12 ms，返回 action 数：3

## Workload

- 单手牌查询：10
- 批量查询：5
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 10 | 0.020 ms | N/A | N/A | N/A | N/A | 49261.08 | 0 |
| batch-hand-strategy | 5 | 0.298 ms | N/A | N/A | N/A | N/A | 3358.41 | 0 |

## 内存

- before RSS：119.74 MB
- after RSS：123.88 MB
- before heap used：626.35 KB
- after heap used：626.35 KB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
