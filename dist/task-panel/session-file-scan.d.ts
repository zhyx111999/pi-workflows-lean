/** Finds a complete JSONL record in an append-only session file without reading the whole history. */
/** Scan the SDK's JSONL record without allocating the entire session history. */
export declare function sessionFileContainsEntry(path: string, entry: object): boolean;
