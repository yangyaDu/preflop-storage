# Benchmark 对比报告

生成时间：2026-06-12T17:58:04.400Z

## 总览

- SQLite 报告：`reports/benchmark-sqlite.json`
- 二进制报告：`reports/benchmark-binary.json`
- SQLite 报告生成时间：2026-06-12T17:57:30.166Z
- 二进制报告生成时间：2026-06-12T17:57:35.182Z
- workload 是否一致：是
- SQLite 冷启动首查：15.02 ms
- 二进制冷启动首查：230.33 ms
- 二进制 / SQLite 冷启动：1533.31%

## 延迟与吞吐

| case | sqlite avg | binary avg | avg ratio | sqlite p95 | binary p95 | p95 ratio | sqlite qps | binary qps | qps ratio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batch-hand-strategy | 0.932 ms | 3.545 ms | 380.32% | 1.279 ms | 6.100 ms | 476.87% | 1071.99 | 281.99 | 0.26x |
| hand-strategy | 0.059 ms | 0.362 ms | 610.86% | 0.105 ms | 0.611 ms | 584.61% | 16798.93 | 2758.93 | 0.16x |

## 内存

- SQLite RSS 变化：6.94 MB
- 二进制 RSS 变化：261.53 MB
- SQLite heap used 变化：0 B
- 二进制 heap used 变化：182.24 MB

## 说明

- Ratio columns use binary / SQLite. Lower latency ratios are better; higher QPS ratios are better.
- Cold start does not clear operating-system file cache, so it is process-level cold start rather than machine-level cold storage.
- The comparison is workload-compatible only when seed, dimensions, iteration counts, and batch size match.
