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

兼容旧接口，找不到 pack 时返回 `null`：

```ts
const result = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "AA",
});
```

如果业务希望使用错误码，使用严格接口：

```ts
const result = await service.getHandStrategyOrThrow({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "AA",
});
```

## 批量查询

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

## 场景级查询

先通过 `drill_name + player_count + drill_depth` 找到抽象行动线，再通过 `abstract_line + depthBb` 找到具体行动线，最后返回每条 concrete line 的手牌策略：

```ts
const results = await service.getScenarioHandStrategies({
  strategy: "default",
  drillName: "BTN vs BB",
  playerCount: 6,
  drillDepth: 0,
  depthBb: 100,
  holeCards: "AKs",
});
```

也可以只解析场景下的具体行动线：

```ts
const lines = service.getScenarioConcreteLines({
  strategy: "default",
  drillName: "BTN vs BB",
  playerCount: 6,
  drillDepth: 0,
  depthBb: 100,
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
  await service.getHandStrategyOrThrow({
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
