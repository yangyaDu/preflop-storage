import { describe, expect, test } from "bun:test";
import { decodeActionSchema, encodeActionSchema } from "../src/binary/action-schema-codec";
import { crc32c } from "../src/binary/crc32c";
import { assertSupportedHeader, decodeFileHeader, encodeFileHeader } from "../src/binary/file-header";
import { decodeRangePack, decodeRangePackForHand, decodeRangePackMaskMatch, encodeRangePack, setMaskBit } from "../src/binary/range-pack-codec";
import { encodeConcreteLinePack } from "../src/importer/build-binary-store";

describe("binary codecs", () => {
  test("crc32c matches the standard check value", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });

  test("file header round trips", () => {
    const header = decodeFileHeader(encodeFileHeader());
    assertSupportedHeader(header);
    expect(header.magic).toBe("PFSP");
    expect(header.version).toBe(1);
  });

  test("action schema round trips", () => {
    const encoded = encodeActionSchema([
      { actionName: "fold", actionSize: 0, amountBB: 0 },
      { actionName: "raise", actionSize: 40, amountBB: 2 },
    ]);

    expect(decodeActionSchema(encoded, 2)).toEqual([
      { actionId: 0, actionName: "fold", actionSize: 0, amountBB: 0 },
      { actionId: 1, actionName: "raise", actionSize: 40, amountBB: 2 },
    ]);
  });

  test("range pack round trips sparse hands and nullable EV", () => {
    const encoded = encodeRangePack({
      handIds: [0, 168],
      actionMasks: [setMaskBit(0, 0), setMaskBit(0, 1)],
      actionCount: 2,
      values: [
        [
          { frequency: 1, handEV: 0.5 },
          { frequency: 0, handEV: null },
        ],
        [
          { frequency: 0, handEV: null },
          { frequency: 0.25, handEV: null },
        ],
      ],
    });

    const decoded = decodeRangePack({ bytes: encoded, handCount: 2, actionCount: 2 });
    expect(decoded.handIds).toEqual([0, 168]);
    expect(decoded.cells[0]).toMatchObject({ handId: 0, actionId: 0, exists: true, frequency: 1, handEV: 0.5 });
    expect(decoded.cells[1]).toMatchObject({ handId: 0, actionId: 1, exists: false, handEV: null });
    expect(decoded.cells[3]).toMatchObject({ handId: 168, actionId: 1, exists: true, handEV: null });
  });

  test("old SQLite rows encode into a concrete-line pack", () => {
    const encoded = encodeConcreteLinePack([
      {
        concrete_line_id: 1,
        hole_cards: "AA",
        action_name: "fold",
        action_size: 0,
        amount_bb: 0,
        frequency: 0.1,
        hand_ev: 0,
      },
      {
        concrete_line_id: 1,
        hole_cards: "AA",
        action_name: "raise",
        action_size: 40,
        amount_bb: 2,
        frequency: 0.9,
        hand_ev: 1.25,
      },
    ]);

    expect(encoded.actionCount).toBe(2);
    expect(encoded.handCount).toBe(1);

    const actions = decodeActionSchema(encoded.actionBlob, encoded.actionCount);
    const pack = decodeRangePack({ bytes: encoded.payload, handCount: encoded.handCount, actionCount: encoded.actionCount });

    expect(actions.map((action) => action.actionName)).toEqual(["fold", "raise"]);
    expect(pack.handIds).toEqual([0]);
    expect(pack.cells[1]).toMatchObject({ exists: true, frequency: expect.closeTo(0.9, 5), handEV: expect.closeTo(1.25, 5) });
  });

  test("decodeRangePackForHand decodes only the target hand", () => {
    const encoded = encodeRangePack({
      handIds: [0, 100, 168],
      actionMasks: [
        setMaskBit(0, 0) | setMaskBit(0, 1),
        setMaskBit(0, 0),
        setMaskBit(0, 1),
      ],
      actionCount: 2,
      values: [
        [{ frequency: 0.5, handEV: 1.0 }, { frequency: 0.3, handEV: -0.5 }],
        [{ frequency: 0.8, handEV: null }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 0.25, handEV: 2.0 }],
      ],
    });

    const cells = decodeRangePackForHand({
      bytes: encoded,
      handCount: 3,
      actionCount: 2,
      targetHandId: 100,
    });

    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ handId: 100, actionId: 0, exists: true, handEV: null });
    expect(cells[0].frequency).toBeCloseTo(0.8, 5);
    expect(cells[1]).toMatchObject({ handId: 100, actionId: 1, exists: false, handEV: null });
  });

  test("decodeRangePackForHand returns empty for missing hand", () => {
    const encoded = encodeRangePack({
      handIds: [0, 100],
      actionMasks: [0, 0],
      actionCount: 1,
      values: [
        [{ frequency: 1, handEV: 0 }],
        [{ frequency: 0.5, handEV: 0 }],
      ],
    });

    const cells = decodeRangePackForHand({
      bytes: encoded,
      handCount: 2,
      actionCount: 1,
      targetHandId: 168,
    });

    expect(cells).toHaveLength(0);
  });

  test("decodeRangePackMaskMatch returns all hands when targetActionIds is empty", () => {
    const encoded = encodeRangePack({
      handIds: [0, 50, 100, 168],
      actionMasks: [0, 0, 0, 0],
      actionCount: 2,
      values: [
        [{ frequency: 0, handEV: null }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 0, handEV: null }],
      ],
    });

    const result = decodeRangePackMaskMatch({
      bytes: encoded,
      handCount: 4,
      actionCount: 2,
      targetActionIds: [],
    });

    expect(result).toEqual([0, 50, 100, 168]);
  });

  test("decodeRangePackMaskMatch filters by single action mask", () => {
    const encoded = encodeRangePack({
      handIds: [0, 50, 100],
      actionMasks: [
        setMaskBit(0, 0),           // has action 0
        setMaskBit(0, 0) | setMaskBit(0, 1), // has actions 0 and 1
        setMaskBit(0, 1),           // has action 1
      ],
      actionCount: 2,
      values: [
        [{ frequency: 1, handEV: 0 }, { frequency: 0, handEV: null }],
        [{ frequency: 1, handEV: 0 }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 1, handEV: 0 }],
      ],
    });

    const result = decodeRangePackMaskMatch({
      bytes: encoded,
      handCount: 3,
      actionCount: 2,
      targetActionIds: [0],
    });

    expect(result).toEqual([0, 50]);
  });

  test("decodeRangePackMaskMatch filters by multiple action masks", () => {
    const encoded = encodeRangePack({
      handIds: [0, 50, 100],
      actionMasks: [
        setMaskBit(0, 0),
        setMaskBit(0, 0) | setMaskBit(0, 1),
        setMaskBit(0, 1),
      ],
      actionCount: 2,
      values: [
        [{ frequency: 1, handEV: 0 }, { frequency: 0, handEV: null }],
        [{ frequency: 1, handEV: 0 }, { frequency: 0, handEV: null }],
        [{ frequency: 0, handEV: null }, { frequency: 1, handEV: 0 }],
      ],
    });

    const result = decodeRangePackMaskMatch({
      bytes: encoded,
      handCount: 3,
      actionCount: 2,
      targetActionIds: [0, 1],
    });

    expect(result).toEqual([50]);
  });
});
