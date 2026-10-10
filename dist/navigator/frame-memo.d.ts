/** Memoizes data lookups for the duration of one render frame. */
/**
 * One frame reads the same runs, saved workflows, and snapshots many times
 * (list, header, panes, footer). Inside `run`, each key is computed once so
 * the frame sees one consistent view; outside a frame every read is fresh.
 */
export declare class FrameMemo {
    private depth;
    private readonly values;
    run<T>(render: () => T): T;
    get<T>(key: string, compute: () => T): T;
}
