import { describe, expect, test } from "bun:test";
import {
  checkFloat32RoundTrip,
  checkNullableFloat32RoundTrip,
  Float32PrecisionStatsAccumulator,
  formatFloat32Bits,
  roundToFloat32,
  toFloat32Bits,
} from "../src/precision/float32";

describe("Float32 precision helpers", () => {
  test("rounds exactly like IEEE754 Float32 storage", () => {
    const source = 0.1;
    const expected = Math.fround(source);

    expect(roundToFloat32(source)).toBe(expected);
    expect(formatFloat32Bits(toFloat32Bits(source))).toBe("0x3dcccccd");
  });

  test("passes only when decoded value is the exact Float32-rounded value", () => {
    const source = 0.1;
    const actual = Math.fround(source);
    const check = checkFloat32RoundTrip(source, actual);

    expect(check.ok).toBe(true);
    expect(check.reason).toBe("OK");
    expect(check.expectedBits).toBe(check.actualBits);
    expect(check.implementationAbsError).toBe(0);
    expect(check.quantizationAbsError).toBeGreaterThan(0);
  });

  test("fails when a value is inside legacy tolerance but lands on a different Float32", () => {
    const source = 0.5000000596046448;
    const actual = 0.5;
    const check = checkFloat32RoundTrip(source, actual);

    expect(Math.abs(source - actual)).toBeLessThan(1e-6);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("FLOAT32_VALUE_MISMATCH");
    expect(check.expectedValue).toBe(source);
    expect(check.actualValue).toBe(actual);
    expect(formatFloat32Bits(check.expectedBits)).toBe("0x3f000001");
    expect(formatFloat32Bits(check.actualBits)).toBe("0x3f000000");
  });

  test("preserves signed zero as part of bit-exact comparison", () => {
    const check = checkFloat32RoundTrip(-0, 0);

    expect(check.ok).toBe(false);
    expect(formatFloat32Bits(check.expectedBits)).toBe("0x80000000");
    expect(formatFloat32Bits(check.actualBits)).toBe("0x00000000");
  });

  test("handles nullable hand EV semantics before numeric comparison", () => {
    expect(checkNullableFloat32RoundTrip(null, null)).toMatchObject({ ok: true, reason: "NULL_MATCH" });
    expect(checkNullableFloat32RoundTrip(null, 0)).toMatchObject({ ok: false, reason: "NULL_MISMATCH" });
    expect(checkNullableFloat32RoundTrip(1.25, null)).toMatchObject({ ok: false, reason: "NULL_MISMATCH" });
    expect(checkNullableFloat32RoundTrip(1.25, Math.fround(1.25))).toMatchObject({ ok: true, reason: "OK" });
  });

  test("accumulates quantization and implementation-loss stats", () => {
    const stats = new Float32PrecisionStatsAccumulator(2, 10);
    stats.add(checkFloat32RoundTrip(0.1, Math.fround(0.1)), "a");
    stats.add(checkFloat32RoundTrip(0.5000000596046448, 0.5), "b");
    stats.addNull();

    const summary = stats.toJSON();
    expect(summary.checkedValues).toBe(2);
    expect(summary.nullValues).toBe(1);
    expect(summary.bitExactValues).toBe(1);
    expect(summary.mismatchValues).toBe(1);
    expect(summary.maxQuantizationAbsError).toBeGreaterThan(0);
    expect(summary.maxImplementationAbsError).toBeGreaterThan(0);
    expect(summary.topQuantizationErrors.length).toBe(2);
  });
});
