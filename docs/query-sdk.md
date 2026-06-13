# Query SDK 使用说明

本文档说明业务侧如何通过 `PreflopQueryService` 读取 `meta.db + ranges_*.bin`，避免直接关心底层文件索引和二进制 pack。

## 初始化

```ts
import { PreflopQueryService } from "../src/query/preflop-query-service";

const service = new PreflopQueryService("range-db/binary/meta.db", "range-db/binary", {
  verifyChecksums: false,
  packCacheSize: 256,
});
```

| 参数 | 说明 |
|---|---|
| `verifyChecksums` | 读取 pack 后校验 CRC32C，适合发布前校验或排查数据损坏 |
| `packCacheSize` | 解码后 pack 的 LRU 缓存数量，默认 `0` 表示不缓存 |

使用完成后关闭文件句柄：

```ts
await service.close();
```

## 单手牌查询

使用 `getHandStrategy`，找不到 pack 时返回 `null`：

```ts
const result = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "AA",
});
```

内部使用 MetaDb prepared statement + 按需解码，只解析目标手牌的 cell 数据。

## 批量查询

自动按 concreteLineId 分组，同一 pack 只读一次，不同 pack 并行读取：

```ts
const results = await service.getHandStrategiesBatch({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [
    { concreteLineId: 1, holeCards: "AA" },
    { concreteLineId: 1, holeCards: "AKs" },
    { concreteLineId: 2, holeCards: "22" },
  ],
});
```

每个返回项结构稳定：

```ts
{
  concreteLineId: 1,
  holeCards: "AA",
  strategy: {
    holeCards: "AA",
    exists: true,
    actions: []
  },
  error: null
}
```

如果某项失败，`strategy` 为 `null`，`error` 包含业务错误码。

## 按 action 筛选手牌

`getHandsByAction` 支持多种查询模式：

```ts
// 查询 pack 中所有手牌
const allHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
});

// 按单个 action 筛选
const raiseHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionNames: ["raise"],
});

// 按多个 action 同时筛选（必须有 raise 且有 call 的手牌）
const raiseAndCallHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionNames: ["raise", "call"],
});

// 带频率阈值筛选
const strongRaises = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionNames: ["raise"],
  minFrequency: 0.1,
});
```

返回 `string[]`（holeCards 数组）。

## 场景元数据查询

```ts
// 查询 drill 场景下的抽象行动线
const lines = service.getDrillScenarioLines({
  strategy: "default",
  drillName: "BTN vs BB",
  playerCount: 6,
  drillDepth: 0,
});

// 查询某条抽象行动线下的具体行动线
const concreteLines = service.getConcreteLines({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  abstractLine: "some line",
});
```

## 错误码

严格查询和 batch 失败项会使用以下错误码：

| 错误码 | 含义 |
|---|---|
| `UNKNOWN_HAND` | 手牌不在固定 169 起手牌字典中 |
| `PACK_NOT_FOUND` | `range_pack_index` 中找不到对应 concrete line |
| `ACTION_SCHEMA_NOT_FOUND` | `action_schemas` 缺失对应 schema |
| `BIN_FILE_NOT_FOUND` | 维度对应的 `ranges_*.bin` 不存在或不可读 |
| `CHECKSUM_MISMATCH` | CRC32C 校验失败 |
| `UNSUPPORTED_DATA_VERSION` | ranges 文件头不是当前代码支持的 PFSP v1 |

```ts
import { PreflopQueryError } from "../src/query/errors";

try {
  await service.getHandStrategy({
    playerCount: 6,
    depthBb: 100,
    concreteLineId: 1,
    holeCards: "bad-hand",
  });
} catch (error) {
  if (error instanceof PreflopQueryError) {
    console.log(error.code, error.details);
  }
}
```
