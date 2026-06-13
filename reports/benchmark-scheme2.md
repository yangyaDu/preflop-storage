# 二进制 Benchmark 报告

生成时间：2026-06-13T06:49:42.631Z

## 总览

- 引擎：binary
- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary-scheme2`
- meta.db：`range-db\binary-scheme2\meta.db`
- 维度：default:6max:100BB, default:6max:200BB, default:6max:300BB, default:8max:100BB, default:8max:200BB, default:8max:300BB, default:9max:100BB, default:9max:200BB, default:9max:300BB
- workload seed：42
- 总迭代：300
- 总耗时：467.93 ms
- 综合 QPS：641.12
- 错误数：0
- 返回 action 总数：5,973
- RSS 变化：52.34 MB
- heap used 变化：23.10 MB
- 冷启动首查：17.39 ms，返回 action 数：3

## Workload

- 单手牌查询：200
- 批量查询：100
- batch size：20
- warmup iterations：20

## 延迟结果

| case | iters | avg | p50 | p95 | p99 | max | qps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hand-strategy | 200 | 0.333 ms | N/A | N/A | N/A | N/A | 3001.27 | 0 |
| batch-hand-strategy | 100 | 4.013 ms | N/A | N/A | N/A | N/A | 249.20 | 0 |

## 内存

- before RSS：185.36 MB
- after RSS：237.71 MB
- before heap used：5.85 MB
- after heap used：28.95 MB

## 说明

- Cold start includes opening meta.db/idx/bin files and running the first hand query.
- Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.
- Result counts sum decoded action entries so work is consumed rather than only requested.
