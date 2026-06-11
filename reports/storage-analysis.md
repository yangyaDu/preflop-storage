# 存储分析报告

生成时间：2026-06-11T15:51:11.285Z

## 新格式总览

- 二进制目录：`range-db/binary`
- meta.db：87.01 MB
- ranges 文件数量：9
- 新格式总大小：346.51 MB
- pack 数量：521,134
- action schema 数量：24,225
- 平均 pack 大小：522 B
- 平均 hand 数：14.07

## 体积对比

- 旧 SQLite 总大小：1.41 GB
- 新二进制总大小：346.51 MB
- 节省体积：1.08 GB
- 新格式 / 旧格式：23.94%
- 降幅：76.06%
- SQLite range 行数：23,806,716


## 维度分布

| dimension | bin file | file size | packs | schemas | avg hands | avg pack |
| --- | --- | --- | --- | --- | --- | --- |
| default 6max 100BB | ranges_default_6max_100BB.bin | 2.07 MB | 3,737 | 613 | 15.76 | 581 B |
| default 6max 200BB | ranges_default_6max_200BB.bin | 1.59 MB | 2,363 | 673 | 18.65 | 705 B |
| default 6max 300BB | ranges_default_6max_300BB.bin | 1.33 MB | 1,816 | 726 | 20.29 | 766 B |
| default 8max 100BB | ranges_default_8max_100BB.bin | 4.42 MB | 8,892 | 1,019 | 14.13 | 521 B |
| default 8max 200BB | ranges_default_8max_200BB.bin | 3.28 MB | 5,454 | 1,049 | 17.06 | 630 B |
| default 8max 300BB | ranges_default_8max_300BB.bin | 2.73 MB | 3,643 | 1,017 | 21.10 | 787 B |
| default 9max 100BB | ranges_default_9max_100BB.bin | 79.88 MB | 197,087 | 4,073 | 11.95 | 425 B |
| default 9max 200BB | ranges_default_9max_200BB.bin | 103.92 MB | 203,028 | 7,878 | 14.26 | 537 B |
| default 9max 300BB | ranges_default_9max_300BB.bin | 60.29 MB | 95,114 | 7,177 | 17.29 | 665 B |

## Action Schema

- schema 数量：19,404
- action 总数：89,944
- 平均 action 数：4.64
- 最少 action 数：2
- 最多 action 数：8

## 说明

- Binary total size counts meta.db plus ranges_*.bin files in the selected directory.
- totalPackBytes is read from range_pack_index.byte_length and should be close to range bin file size minus 16-byte headers.
- Compression ratio here compares current generated binary data against the source SQLite file size reported by analyze-sqlite.
