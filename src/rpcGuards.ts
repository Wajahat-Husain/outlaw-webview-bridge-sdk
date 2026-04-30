import type {
  BridgeEnvelope,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcSuccess,
} from "./bridgeTypes.js";

/**
 * Narrows unknown input to a plain object-like record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * JSON-RPC allows id values to be either strings or numbers.
 */
function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Validates the shape of a JSON-RPC error response payload.
 */
function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  if (!isRecord(value)) return false;
  if (value.jsonrpc !== "2.0" || !isJsonRpcId(value.id)) return false;
  if (!isRecord(value.error)) return false;
  return (
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  );
}

/**
 * Validates the shape of a JSON-RPC success response payload.
 */
function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess<unknown> {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    isJsonRpcId(value.id) &&
    "result" in value
  );
}

/**
 * Accepts either JSON-RPC success or error envelopes.
 */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isJsonRpcErrorResponse(value) || isJsonRpcSuccess(value);
}

/**
 * Ensures message data is a bridge response envelope for this protocol.
 */
export function isBridgeResponseEnvelope(
  value: unknown,
): value is BridgeEnvelope {
  if (!isRecord(value)) return false;
  if (value.type !== "OUTLAW_BRIDGE_RESPONSE") return false;
  if (typeof value.clientId !== "string") return false;
  if (
    "sessionId" in value &&
    value.sessionId !== undefined &&
    typeof value.sessionId !== "string"
  ) {
    return false;
  }
  return isJsonRpcResponse(value.payload);
}
