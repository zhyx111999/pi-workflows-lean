/**
 * fs calls reach such a directory literally, but process creation normalizes
 * the path: it drops a single trailing period from inner segments and all
 * trailing periods and spaces from the last segment. The agent's shell would
 * then run in a different, possibly existing, directory than its file tools.
 */
export declare function assertProcessesStartIn(cwd: string, label: string | undefined): void;
