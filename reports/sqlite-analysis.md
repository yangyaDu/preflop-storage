# SQLite 数据分析报告

生成时间：2026-06-11T15:51:10.664Z

## 总览

- 源数据库：`range-db/range.db`
- 主文件大小：1.41 GB
- WAL/SHM 大小：32.00 KB
- 文件总大小：1.41 GB
- SQLite page size：4,096
- SQLite page count：370,544
- 表数量：20
- 索引数量：19
- 总行数：24,331,159
- range 行数：23,806,716
- concrete line 行数：521,134
- drill 行数：3,290

## Range 表体积压力

- range 字段 payload 粗估：1.04 GB
- 重复 `hole_cards` 字符串粗估：61.77 MB
- 重复 `action_name` 字符串粗估：99.54 MB

| range table | rows | concrete lines | avg rows / line | rough payload | repeated strings |
| --- | --- | --- | --- | --- | --- |
| range_data_default_9max_200BB | 9,594,303 | 203,028 | 47 | 430.85 MB | 64.86 MB |
| range_data_default_9max_100BB | 7,666,604 | 197,087 | 39 | 344.57 MB | 52.11 MB |
| range_data_default_9max_300BB | 5,186,549 | 95,114 | 55 | 232.93 MB | 35.07 MB |
| range_data_default_8max_100BB | 398,839 | 8,892 | 45 | 17.93 MB | 2.72 MB |
| range_data_default_8max_200BB | 283,878 | 5,454 | 52 | 12.76 MB | 1.93 MB |
| range_data_default_8max_300BB | 225,292 | 3,643 | 62 | 10.12 MB | 1.53 MB |
| range_data_default_6max_100BB | 194,021 | 3,737 | 52 | 8.73 MB | 1.33 MB |
| range_data_default_6max_200BB | 142,742 | 2,363 | 60 | 6.42 MB | 1000.06 KB |
| range_data_default_6max_300BB | 114,488 | 1,816 | 63 | 5.15 MB | 799.51 KB |

## 表结构与行数

| table | kind | rows | indexes |
| --- | --- | --- | --- |
| concrete_lines_default_6max_100BB | concrete | 3,737 | 1 |
| concrete_lines_default_6max_200BB | concrete | 2,363 | 1 |
| concrete_lines_default_6max_300BB | concrete | 1,816 | 1 |
| concrete_lines_default_8max_100BB | concrete | 8,892 | 1 |
| concrete_lines_default_8max_200BB | concrete | 5,454 | 1 |
| concrete_lines_default_8max_300BB | concrete | 3,643 | 1 |
| concrete_lines_default_9max_100BB | concrete | 197,087 | 1 |
| concrete_lines_default_9max_200BB | concrete | 203,028 | 1 |
| concrete_lines_default_9max_300BB | concrete | 95,114 | 1 |
| drill_scenario_lines_default | drill | 3,290 | 1 |
| range_data_default_6max_100BB | range | 194,021 | 1 |
| range_data_default_6max_200BB | range | 142,742 | 1 |
| range_data_default_6max_300BB | range | 114,488 | 1 |
| range_data_default_8max_100BB | range | 398,839 | 1 |
| range_data_default_8max_200BB | range | 283,878 | 1 |
| range_data_default_8max_300BB | range | 225,292 | 1 |
| range_data_default_9max_100BB | range | 7,666,604 | 1 |
| range_data_default_9max_200BB | range | 9,594,303 | 1 |
| range_data_default_9max_300BB | range | 5,186,549 | 1 |
| sqlite_sequence | sqlite_internal | 19 | 0 |

## 说明

- Bun SQLite in this environment does not expose dbstat, so per-table byte sizes are not page-accurate.
- roughRangeFieldPayloadBytes is an approximate lower payload estimate, not the real SQLite storage size.
- repeatedHoleCardsBytes and repeatedActionNameBytes show repeated string payload pressure in old row-style range tables.
