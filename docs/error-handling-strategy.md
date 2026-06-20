# 错误处理策略

> 版本：1.0
> 生成日期：2026-06-17
> 关联问题：P2-7 错误处理风格不一致（`docs/issues-and-action-items.md`）

## 1. 错误类层次

```
Error
├── PreflopStoreError    —— 格式/IO/构建层错误
│   code: "INVALID_FORMAT" | "INVALID_ARGUMENT" | "IO_ERROR" | "BUILD_ERROR" | "UNSUPPORTED_DATA_VERSION"
│
├── PreflopQueryError     —— 查询服务层错误
│   code: "UNKNOWN_HAND" | "PACK_NOT_FOUND" | "ACTION_SCHEMA_NOT_FOUND" | "BIN_FILE_NOT_FOUND" | "INVALID_FORMAT" | "CHECKSUM_MISMATCH" | "UNSUPPORTED_DATA_VERSION"
│
└── Error                 —— 内部不变式违反（编程错误，不应在生产环境出现）
```

## 2. 使用原则

### 2.1 PreflopStoreError — 二进制/构建层

用于可以被调用方捕获并处理的错误：

- **INVALID_FORMAT**：数据格式错误（header magic、pack 长度、schema 不匹配）
- **INVALID_ARGUMENT**：用户提供的参数不合法（未知 action name）
- **IO_ERROR**：文件读写失败
- **BUILD_ERROR**：构建流程错误（输出已存在未 overwrite、prepared statement 缺失）
- **UNSUPPORTED_DATA_VERSION**：数据文件版本不兼容

```ts
// 示例：二进制 header 校验
throw new PreflopStoreError("INVALID_FORMAT", `Invalid .bin header length: ${len}`, { expected: 16, got: len });

// 示例：构建冲突
throw new PreflopStoreError("BUILD_ERROR", "Output already exists. Pass --overwrite.");
```

### 2.2 PreflopQueryError — 查询服务层

用于查询 SDK 返回给业务方的错误，携带结构化错误码：

```ts
throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${cards}`, { holeCards: cards });
```

### 2.3 普通 Error — 内部不变式

保留用于表示"不应发生"的编程错误（通常意味着 bug）：

```ts
// 内部数组长度一致性校验（编程错误而非数据错误）
if (actionMasks.length !== handCount) {
  throw new Error(`Internal invariant violated: masks ${actionMasks.length} vs hands ${handCount}`);
}
```

## 3. 各层错误分布

| 层面 | 错误类 | 说明 |
|------|--------|------|
| `src/binary/` 格式编解码 | `PreflopStoreError` | 格式校验、CRC 不匹配、版本不兼容 |
| `src/range-strata-binary/index/` 索引格式 | `PreflopStoreError` | .idx header 校验 |
| `src/range-strata-binary/compiler/` 构建工具 | `PreflopStoreError` | 构建流程错误 |
| `src/query/` 查询服务 | `PreflopQueryError` | 手牌未知、pack 未找到等 |
| `src/cli/` CLI 参数解析 | `Error` | 参数合法性校验（用户直接可读） |
| `src/benchmark/` 采样逻辑 | `Error` | 数据缺失（采样前校验，表示数据源问题） |
| 内部数组/状态一致性 | `Error` | 编程 bug |

## 4. 错误码映射

查询服务层错误码的语义和使用场景：

| 错误码 | 含义 | 触发场景 |
|--------|------|---------|
| `UNKNOWN_HAND` | 手牌不在 169 起手牌字典 | 传入非法 holeCards |
| `PACK_NOT_FOUND` | 找不到对应 concrete line 的 range pack | concreteLineId 无效 |
| `ACTION_SCHEMA_NOT_FOUND` | 缺失 action schema | meta.db 数据不完整 |
| `BIN_FILE_NOT_FOUND` | .idx/.bin 文件不存在 | 维度未预热或文件缺失 |
| `INVALID_FORMAT` | .idx/.bin 内容不符合格式约束 | idx offset/length 越界、pack 长度非法 |
| `CHECKSUM_MISMATCH` | CRC32C 校验失败 | 数据损坏 |
| `UNSUPPORTED_DATA_VERSION` | PFSP 版本不兼容 | 旧版数据文件 |

## 5. 变更记录

- 2026-06-17：统一各层错误类型。二进制/构建层改用 `PreflopStoreError`，查询层保持 `PreflopQueryError`。内部不变式保留 `Error`。
- 2026-06-19：Range Strata Binary Rust 热路径将 checksum mismatch、idx/bin 格式损坏映射为查询层结构化错误；查询错误码新增 `INVALID_FORMAT`。
