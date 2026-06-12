# Benchmark 对比报告

生成时间：2026-06-12T12:57:22.803Z

## 总览

- SQLite 报告：`reports/benchmark-sqlite.json`
- 二进制报告：`reports/benchmark-binary.json`
- SQLite 报告生成时间：2026-06-12T12:56:34.675Z
- 二进制报告生成时间：2026-06-12T12:57:06.285Z
- workload 是否一致：是
- SQLite 冷启动首查：15.53 ms
- 二进制冷启动首查：27.85 ms
- 二进制 / SQLite 冷启动：179.25%

## 延迟与吞吐

| case | sqlite avg | binary avg | avg ratio | sqlite p95 | binary p95 | p95 ratio | sqlite qps | binary qps | qps ratio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batch-hand-strategy | 1.019 ms | 19.16 ms | 1880.13% | 1.736 ms | 28.26 ms | 1627.91% | 980.56 | 52.19 | 0.05x |
| drill-random | 16.38 ms | 254.78 ms | 1555.02% | 65.75 ms | 1.57 s | 2393.89% | 61.03 | 3.92 | 0.06x |
| full-range | 0.493 ms | 1.405 ms | 285.04% | 1.367 ms | 2.363 ms | 172.83% | 2027.13 | 711.54 | 0.35x |
| hand-strategy | 0.059 ms | 1.684 ms | 2841.88% | 0.148 ms | 3.147 ms | 2127.99% | 16785.56 | 593.29 | 0.04x |

## 内存

- SQLite RSS 变化：24.16 MB
- 二进制 RSS 变化：103.48 MB
- SQLite heap used 变化：0 B
- 二进制 heap used 变化：31.21 MB

## 说明

- Ratio columns use binary / SQLite. Lower latency ratios are better; higher QPS ratios are better.
- Cold start does not clear operating-system file cache, so it is process-level cold start rather than machine-level cold storage.
- The comparison is workload-compatible only when seed, dimensions, iteration counts, and batch size match.
