// The RPC deadline leaves time for command cancellation, helper cleanup, and returning the result.
export const DEVICE_OPERATION_TIMEOUT_MS = 120_000;
export const DEVICE_REQUEST_TIMEOUT_MS = DEVICE_OPERATION_TIMEOUT_MS + 15_000;
