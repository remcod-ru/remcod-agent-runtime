export type RetryClassification = "transient" | "permanent";

export interface RetryPolicy {
  maxAttempts: number;
  classify(error: unknown): RetryClassification;
  delayMs(attempt: number): number;
}

function hasRetryableFlag(
  error: unknown,
): error is { readonly retryable: boolean } {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  );
}

export const defaultRetryPolicy: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  classify(error: unknown): RetryClassification {
    return hasRetryableFlag(error) && error.retryable
      ? "transient"
      : "permanent";
  },
  delayMs(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) return 0;
    return Math.min(100 * 2 ** (attempt - 1), 5_000);
  },
});
