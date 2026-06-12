# 二进制一致性校验报告

生成时间：2026-06-12T06:22:14.593Z

## 总览

- 源 SQLite：`range-db/range.db`
- 二进制目录：`range-db/binary`
- meta.db：`range-db\binary\meta.db`
- 模式：full
- sample size：N/A
- 维度数量：9
- 校验 concrete line：521,134
- 校验旧记录数：23,806,716
- 成功旧记录数：23,806,646
- 失败旧记录数：70
- 二进制额外记录数：0
- 失败记录总数：70
- pack 读取失败数：0
- frequency 最大误差：2.9802321499516893e-8
- hand_ev 最大误差：0.0000152587890625

## 误差阈值

- action_size：0.000001
- amount_bb：0.000001
- frequency：0.000001
- hand_ev：0.00001

## 维度结果

| dimension | lines | checked old rows | success | failed old rows | extra binary rows | pack failures |
| --- | --- | --- | --- | --- | --- | --- |
| default:6max:100BB | 3,737 | 194,021 | 194,021 | 0 | 0 | 0 |
| default:6max:200BB | 2,363 | 142,742 | 142,742 | 0 | 0 | 0 |
| default:6max:300BB | 1,816 | 114,488 | 114,488 | 0 | 0 | 0 |
| default:8max:100BB | 8,892 | 398,839 | 398,839 | 0 | 0 | 0 |
| default:8max:200BB | 5,454 | 283,878 | 283,878 | 0 | 0 | 0 |
| default:8max:300BB | 3,643 | 225,292 | 225,292 | 0 | 0 | 0 |
| default:9max:100BB | 197,087 | 7,666,604 | 7,666,604 | 0 | 0 | 0 |
| default:9max:200BB | 203,028 | 9,594,303 | 9,594,303 | 0 | 0 | 0 |
| default:9max:300BB | 95,114 | 5,186,549 | 5,186,479 | 70 | 0 | 0 |

## 失败样例

| dimension | line | hand | action | reason | details |
| --- | --- | --- | --- | --- | --- |
| default:9max:300BB | 10268 | AA | raise | HAND_EV_MISMATCH | old=264.3915557861328, binary=264.39154052734375, error=0.0000152587890625 |
| default:9max:300BB | 12876 | AA | raise | HAND_EV_MISMATCH | old=276.2884063720703, binary=276.28839111328125, error=0.0000152587890625 |
| default:9max:300BB | 12999 | AA | raise | HAND_EV_MISMATCH | old=268.9251251220703, binary=268.92510986328125, error=0.0000152587890625 |
| default:9max:300BB | 13041 | AA | raise | HAND_EV_MISMATCH | old=272.3891143798828, binary=272.38909912109375, error=0.0000152587890625 |
| default:9max:300BB | 15957 | AA | raise | HAND_EV_MISMATCH | old=260.9138946533203, binary=260.91387939453125, error=0.0000152587890625 |
| default:9max:300BB | 16014 | AA | raise | HAND_EV_MISMATCH | old=273.1565399169922, binary=273.15655517578125, error=0.0000152587890625 |
| default:9max:300BB | 54533 | AA | raise | HAND_EV_MISMATCH | old=263.6796112060547, binary=263.67962646484375, error=0.0000152587890625 |
| default:9max:300BB | 54539 | AA | raise | HAND_EV_MISMATCH | old=281.2248992919922, binary=281.22491455078125, error=0.0000152587890625 |
| default:9max:300BB | 54560 | AA | raise | HAND_EV_MISMATCH | old=274.48182678222656, binary=274.4818115234375, error=0.0000152587890625 |
| default:9max:300BB | 54561 | AA | raise | HAND_EV_MISMATCH | old=283.55397033691406, binary=283.553955078125, error=0.0000152587890625 |
| default:9max:300BB | 54570 | AA | raise | HAND_EV_MISMATCH | old=264.32518005371094, binary=264.3251953125, error=0.0000152587890625 |
| default:9max:300BB | 54618 | AA | raise | HAND_EV_MISMATCH | old=269.91990661621094, binary=269.919921875, error=0.0000152587890625 |
| default:9max:300BB | 54657 | AA | raise | HAND_EV_MISMATCH | old=266.6521759033203, binary=266.65216064453125, error=0.0000152587890625 |
| default:9max:300BB | 54709 | AA | raise | HAND_EV_MISMATCH | old=275.38587951660156, binary=275.3858642578125, error=0.0000152587890625 |
| default:9max:300BB | 54740 | AA | raise | HAND_EV_MISMATCH | old=280.5611114501953, binary=280.56109619140625, error=0.0000152587890625 |
| default:9max:300BB | 54764 | AA | raise | HAND_EV_MISMATCH | old=263.5344696044922, binary=263.53448486328125, error=0.0000152587890625 |
| default:9max:300BB | 54777 | AA | raise | HAND_EV_MISMATCH | old=271.9306182861328, binary=271.93060302734375, error=0.0000152587890625 |
| default:9max:300BB | 54779 | AA | raise | HAND_EV_MISMATCH | old=290.13194274902344, binary=290.1319580078125, error=0.0000152587890625 |
| default:9max:300BB | 54784 | AA | raise | HAND_EV_MISMATCH | old=279.0478057861328, binary=279.04779052734375, error=0.0000152587890625 |
| default:9max:300BB | 54785 | AA | raise | HAND_EV_MISMATCH | old=289.0269012451172, binary=289.02691650390625, error=0.0000152587890625 |
| default:9max:300BB | 54815 | AA | raise | HAND_EV_MISMATCH | old=276.5813446044922, binary=276.58135986328125, error=0.0000152587890625 |
| default:9max:300BB | 54838 | AA | raise | HAND_EV_MISMATCH | old=273.95286560058594, binary=273.952880859375, error=0.0000152587890625 |
| default:9max:300BB | 54843 | AA | raise | HAND_EV_MISMATCH | old=264.45262145996094, binary=264.45263671875, error=0.0000152587890625 |
| default:9max:300BB | 54844 | AA | raise | HAND_EV_MISMATCH | old=276.0971221923828, binary=276.09710693359375, error=0.0000152587890625 |
| default:9max:300BB | 54850 | AA | raise | HAND_EV_MISMATCH | old=283.6719512939453, binary=283.67193603515625, error=0.0000152587890625 |
| default:9max:300BB | 54881 | AA | raise | HAND_EV_MISMATCH | old=268.6384735107422, binary=268.63848876953125, error=0.0000152587890625 |
| default:9max:300BB | 54983 | AA | raise | HAND_EV_MISMATCH | old=266.0364532470703, binary=266.03643798828125, error=0.0000152587890625 |
| default:9max:300BB | 55003 | AA | raise | HAND_EV_MISMATCH | old=305.6346893310547, binary=305.63470458984375, error=0.0000152587890625 |
| default:9max:300BB | 55135 | AA | raise | HAND_EV_MISMATCH | old=291.51600646972656, binary=291.5159912109375, error=0.0000152587890625 |
| default:9max:300BB | 55198 | AA | raise | HAND_EV_MISMATCH | old=268.5120086669922, binary=268.51202392578125, error=0.0000152587890625 |
| default:9max:300BB | 55475 | AA | raise | HAND_EV_MISMATCH | old=269.72984313964844, binary=269.7298583984375, error=0.0000152587890625 |
| default:9max:300BB | 55496 | AA | raise | HAND_EV_MISMATCH | old=287.9462432861328, binary=287.94622802734375, error=0.0000152587890625 |
| default:9max:300BB | 55542 | AA | raise | HAND_EV_MISMATCH | old=285.0281219482422, binary=285.02813720703125, error=0.0000152587890625 |
| default:9max:300BB | 57300 | AA | raise | HAND_EV_MISMATCH | old=271.3563690185547, binary=271.35638427734375, error=0.0000152587890625 |
| default:9max:300BB | 57732 | AA | raise | HAND_EV_MISMATCH | old=281.1646270751953, binary=281.16461181640625, error=0.0000152587890625 |
| default:9max:300BB | 63374 | AA | raise | HAND_EV_MISMATCH | old=263.28480529785156, binary=263.2847900390625, error=0.0000152587890625 |
| default:9max:300BB | 63399 | AA | raise | HAND_EV_MISMATCH | old=263.2848358154297, binary=263.28485107421875, error=0.0000152587890625 |
| default:9max:300BB | 64518 | AA | raise | HAND_EV_MISMATCH | old=256.5437469482422, binary=256.54376220703125, error=0.0000152587890625 |
| default:9max:300BB | 64523 | AA | raise | HAND_EV_MISMATCH | old=272.10450744628906, binary=272.1044921875, error=0.0000152587890625 |
| default:9max:300BB | 64621 | AA | raise | HAND_EV_MISMATCH | old=269.99159240722656, binary=269.9915771484375, error=0.0000152587890625 |
| default:9max:300BB | 67660 | AA | raise | HAND_EV_MISMATCH | old=264.7552032470703, binary=264.75518798828125, error=0.0000152587890625 |
| default:9max:300BB | 67801 | AA | raise | HAND_EV_MISMATCH | old=260.5946807861328, binary=260.59466552734375, error=0.0000152587890625 |
| default:9max:300BB | 67928 | AA | raise | HAND_EV_MISMATCH | old=266.5386199951172, binary=266.53863525390625, error=0.0000152587890625 |
| default:9max:300BB | 75603 | AA | raise | HAND_EV_MISMATCH | old=281.31468200683594, binary=281.314697265625, error=0.0000152587890625 |
| default:9max:300BB | 75913 | AA | raise | HAND_EV_MISMATCH | old=269.95518493652344, binary=269.9552001953125, error=0.0000152587890625 |
| default:9max:300BB | 76100 | AA | raise | HAND_EV_MISMATCH | old=289.42967224121094, binary=289.4296875, error=0.0000152587890625 |
| default:9max:300BB | 76345 | AA | raise | HAND_EV_MISMATCH | old=281.21910095214844, binary=281.2191162109375, error=0.0000152587890625 |
| default:9max:300BB | 76380 | AA | raise | HAND_EV_MISMATCH | old=284.62391662597656, binary=284.6239013671875, error=0.0000152587890625 |
| default:9max:300BB | 76824 | AA | raise | HAND_EV_MISMATCH | old=288.73753356933594, binary=288.737548828125, error=0.0000152587890625 |
| default:9max:300BB | 79158 | AA | raise | HAND_EV_MISMATCH | old=267.1006317138672, binary=267.10064697265625, error=0.0000152587890625 |

## 修复建议

- 确认二进制目录由当前 source SQLite 重新构建，避免 meta.db 与 ranges_*.bin 来自不同版本。
- 使用 --verify-checksum 或本命令重新扫描，优先排查 ranges_*.bin 是否损坏。
- 如出现大量 ACTION_NOT_FOUND_IN_SCHEMA，检查 action_name 规范化和 action_size / amount_bb 的 Float32 精度策略。
