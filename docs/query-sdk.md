# Query SDK 使用说明

本文档说明业务侧如何通过查询服务读取策略数据。当前推荐 **Scheme2QueryService**（Rust 热路径 + .idx/.bin 文件），性能远优于旧方案。

## 推荐方案：Scheme2QueryService（方案二 + Rust）

热路径为 Rust napi-rs DimensionHandle（mmap .idx + .bin），冷路径（场景元数据、action schema）走 meta.db SQLite。

### 初始化

```ts
import { Scheme2QueryService } from "../src/scheme2/query/query-service";

const service = new Scheme2QueryService("range-db/binary-scheme2/meta.db", "range-db/binary-scheme2", {
  verifyChecksums: false,
  maxOpenHandles: 3,                // LRU mmap handle 池大小（默认 3）
  prewarmActionSchemas: false,      // true = 启动时全量加载所有 action schema
});
```

### 预热维度（同步）

必须先预热维度才能使用同步查询路径。内部会 `.idx` mmap + `.bin` mmap，并自动预加载该维度引用的 action schema。

```ts
service.prewarmDimension({ strategy: "default", playerCount: 6, depthBb: 100 });
```

### 同步单手牌查询（推荐热路径）

```ts
const strategy = service.getHandStrategySync({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "22",
});
// → { holeCards: "22", exists: true, actions: [...] }
```

p50 延迟 ~0.009ms，QPS ~92,600。

### 同步批量查询

```ts
const results = service.getHandStrategiesBatchSync({
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

内部走 Flat TypedArray 批量传输，避开 napi object 序列化。p50 ~0.096ms (batch=20)。

### 异步查询（自动预热）

首次调用时自动打开文件并预热 schema：

```ts
const strategy = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 2,
  holeCards: "AA",
});

const batch = await service.getHandStrategiesBatch({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [
    { concreteLineId: 1, holeCards: "AA" },
  ],
});
```

### 场景元数据查询

```ts
const lines = service.getDrillScenarioLines({ drillName: "UTG", playerCount: 6 });
const concrete = service.getConcreteLines({ playerCount: 6, depthBb: 100, abstractLine: lines[0] });
```

### 轻量批量计数

不需要完整 strategy 时，仅返回总 action 数：

```ts
const totalActions = service.getHandStrategiesCountBatchSync({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [...],
});
```

### 关闭

```ts
service.close();
```

---

## 旧方案：PreflopQueryService（方案一，SQLite 索引 + .bin）

热路径为纯 JS（SQLite 查索引 + fs 读 .bin + JS 解码），性能劣于 SQLite，已不推荐使用。保留仅用于兼容 `getHandsByAction` 接口。

### 初始化

```ts
import { PreflopQueryService } from "../src/query/preflop-query-service";

const service = new PreflopQueryService("range-db/binary/meta.db", "range-db/binary", {
  verifyChecksums: false,
  packCacheSize: 256,
});
```

| 参数 | 说明 |
|---|---|
| `verifyChecksums` | 读取 pack 后校验 CRC32C |
| `packCacheSize` | pack 的 LRU 缓存数量，默认 `0` |

### 单手牌查询（异步）

```ts
const result = await service.getHandStrategy({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  holeCards: "AA",
});
```

### 批量查询（异步）

```ts
const results = await service.getHandStrategiesBatch({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  requests: [
    { concreteLineId: 1, holeCards: "AA" },
    { concreteLineId: 1, holeCards: "AKs" },
  ],
});
```

每个返回项 `{ strategy, error }` 结构稳定。

### 按 action 筛选手牌

```ts
const raiseHands = await service.getHandsByAction({
  strategy: "default",
  playerCount: 6,
  depthBb: 100,
  concreteLineId: 1,
  actionNames: ["raise"],
  minFrequency: 0.1,
});
// → string[]（holeCards 数组）
```

---

## 返回结构

```ts
interface HandStrategy {
  holeCards: string;
  exists: boolean;
  actions: ActionResult[];
}

interface ActionResult {
  actionName: ActionName;
  actionSize: number;
  amountBB: number;
  frequency: number;
  handEV: number | null;
  exists: boolean;
}
```

## 错误码

| 错误码 | 含义 |
|---|---|
| `UNKNOWN_HAND` | 手牌不在固定 169 起手牌字典中 |
| `PACK_NOT_FOUND` | range pack 中找不到对应 concrete line |
| `ACTION_SCHEMA_NOT_FOUND` | `action_schemas` 缺失对应 schema |
| `BIN_FILE_NOT_FOUND` | 维度对应的 `.idx` / `.bin` 不存在或不可读 |
| `CHECKSUM_MISMATCH` | CRC32C 校验失败 |
| `UNSUPPORTED_DATA_VERSION` | 文件头不是当前支持的 PFSP v1 |

```ts
import { PreflopQueryError } from "../src/query/errors";

try {
  await service.getHandStrategy({ ... });
} catch (error) {
  if (error instanceof PreflopQueryError) {
    console.log(error.code, error.details);
  }
}
```
