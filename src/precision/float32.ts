export interface Float32RoundTripCheck {
  ok: boolean;
  reason: "OK" | "NON_FINITE_SOURCE" | "NON_FINITE_ACTUAL" | "FLOAT32_VALUE_MISMATCH";
  sourceValue: number;
  expectedValue: number;
  actualValue: number;
  expectedBits: number;
  actualBits: number;
  quantizationAbsError: number;
  quantizationRelativeError: number;
  implementationAbsError: number;
}

export interface NullableFloat32RoundTripCheck {
  ok: boolean;
  reason:
    | "OK"
    | "NULL_MATCH"
    | "NULL_MISMATCH"
    | "NON_FINITE_SOURCE"
    | "NON_FINITE_ACTUAL"
    | "FLOAT32_VALUE_MISMATCH";
  value: Float32RoundTripCheck | null;
}

export interface Float32ErrorSample {
  context: string;
  sourceValue: number;
  expectedValue: number;
  actualValue: number;
  expectedBits: string;
  actualBits: string;
  quantizationAbsError: number;
  quantizationRelativeError: number;
  implementationAbsError: number;
}

export interface Float32PrecisionStats {
  checkedValues: number;
  nullValues: number;
  bitExactValues: number;
  mismatchValues: number;
  maxQuantizationAbsError: number;
  maxQuantizationRelativeError: number;
  maxImplementationAbsError: number;
  p95QuantizationAbsError: number;
  p99QuantizationAbsError: number;
  topQuantizationErrors: Float32ErrorSample[];
}

export function roundToFloat32(value: number): number {
  return Math.fround(value);
}

export function toFloat32Bits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

export function formatFloat32Bits(bits: number): string {
  return `0x${(bits >>> 0).toString(16).padStart(8, "0")}`;
}

export function checkFloat32RoundTrip(sourceValue: number, actualValue: number): Float32RoundTripCheck {
  const expectedValue = roundToFloat32(sourceValue);
  const expectedBits = toFloat32Bits(sourceValue);
  const actualBits = toFloat32Bits(actualValue);
  const quantizationAbsError = Math.abs(sourceValue - expectedValue);
  const quantizationRelativeError = quantizationAbsError / Math.max(Math.abs(sourceValue), 1);
  const implementationAbsError = Math.abs(actualValue - expectedValue);

  if (!Number.isFinite(sourceValue)) {
    return {
      ok: false,
      reason: "NON_FINITE_SOURCE",
      sourceValue,
      expectedValue,
      actualValue,
      expectedBits,
      actualBits,
      quantizationAbsError,
      quantizationRelativeError,
      implementationAbsError,
    };
  }

  if (!Number.isFinite(actualValue)) {
    return {
      ok: false,
      reason: "NON_FINITE_ACTUAL",
      sourceValue,
      expectedValue,
      actualValue,
      expectedBits,
      actualBits,
      quantizationAbsError,
      quantizationRelativeError,
      implementationAbsError,
    };
  }

  const ok = expectedBits === actualBits && Object.is(expectedValue, actualValue);
  return {
    ok,
    reason: ok ? "OK" : "FLOAT32_VALUE_MISMATCH",
    sourceValue,
    expectedValue,
    actualValue,
    expectedBits,
    actualBits,
    quantizationAbsError,
    quantizationRelativeError,
    implementationAbsError,
  };
}

export function checkNullableFloat32RoundTrip(
  sourceValue: number | null,
  actualValue: number | null,
): NullableFloat32RoundTripCheck {
  if (sourceValue === null && actualValue === null) {
    return { ok: true, reason: "NULL_MATCH", value: null };
  }

  if (sourceValue === null || actualValue === null) {
    return { ok: false, reason: "NULL_MISMATCH", value: null };
  }

  const value = checkFloat32RoundTrip(sourceValue, actualValue);
  return {
    ok: value.ok,
    reason: value.reason,
    value,
  };
}

export class Float32PrecisionStatsAccumulator {
  private readonly quantizationSample: number[] = [];
  private readonly topErrors: Float32ErrorSample[] = [];
  private checkedValues = 0;
  private nullValues = 0;
  private bitExactValues = 0;
  private mismatchValues = 0;
  private maxQuantizationAbsError = 0;
  private maxQuantizationRelativeError = 0;
  private maxImplementationAbsError = 0;
  private reservoirState = 0x9e3779b9;

  constructor(
    private readonly topErrorLimit = 20,
    private readonly reservoirSize = 8192,
  ) {}

  addNull(): void {
    this.nullValues += 1;
  }

  add(check: Float32RoundTripCheck, context: string): void {
    this.checkedValues += 1;
    if (check.ok) {
      this.bitExactValues += 1;
    } else {
      this.mismatchValues += 1;
    }

    this.maxQuantizationAbsError = Math.max(this.maxQuantizationAbsError, check.quantizationAbsError);
    this.maxQuantizationRelativeError = Math.max(this.maxQuantizationRelativeError, check.quantizationRelativeError);
    this.maxImplementationAbsError = Math.max(this.maxImplementationAbsError, check.implementationAbsError);
    this.addToReservoir(check.quantizationAbsError);
    this.addTopError(check, context);
  }

  toJSON(): Float32PrecisionStats {
    const sorted = [...this.quantizationSample].sort((left, right) => left - right);
    return {
      checkedValues: this.checkedValues,
      nullValues: this.nullValues,
      bitExactValues: this.bitExactValues,
      mismatchValues: this.mismatchValues,
      maxQuantizationAbsError: this.maxQuantizationAbsError,
      maxQuantizationRelativeError: this.maxQuantizationRelativeError,
      maxImplementationAbsError: this.maxImplementationAbsError,
      p95QuantizationAbsError: percentile(sorted, 0.95),
      p99QuantizationAbsError: percentile(sorted, 0.99),
      topQuantizationErrors: [...this.topErrors],
    };
  }

  private addToReservoir(value: number): void {
    if (this.quantizationSample.length < this.reservoirSize) {
      this.quantizationSample.push(value);
      return;
    }

    this.reservoirState = (Math.imul(this.reservoirState, 1664525) + 1013904223) >>> 0;
    const index = this.reservoirState % this.checkedValues;
    if (index < this.reservoirSize) {
      this.quantizationSample[index] = value;
    }
  }

  private addTopError(check: Float32RoundTripCheck, context: string): void {
    if (this.topErrorLimit <= 0) return;

    const sample: Float32ErrorSample = {
      context,
      sourceValue: check.sourceValue,
      expectedValue: check.expectedValue,
      actualValue: check.actualValue,
      expectedBits: formatFloat32Bits(check.expectedBits),
      actualBits: formatFloat32Bits(check.actualBits),
      quantizationAbsError: check.quantizationAbsError,
      quantizationRelativeError: check.quantizationRelativeError,
      implementationAbsError: check.implementationAbsError,
    };

    this.topErrors.push(sample);
    this.topErrors.sort((left, right) => right.quantizationAbsError - left.quantizationAbsError);
    if (this.topErrors.length > this.topErrorLimit) {
      this.topErrors.length = this.topErrorLimit;
    }
  }
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * quantile) - 1));
  return sortedValues[index];
}
