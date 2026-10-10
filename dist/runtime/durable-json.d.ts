/** Lossless JSON copies for checkpoint payloads and responses that must survive persistence exactly. */
/**
 * Copy a checkpoint payload or response that must survive persistence exactly:
 * only plain objects, dense arrays, strings, finite numbers, booleans and null
 * are accepted; anything a JSON round trip would change throws a TypeError.
 */
export declare function cloneDurableJsonValue(value: unknown, label: string): unknown;
