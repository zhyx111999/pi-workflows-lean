/** A bounded per-overlay cache for expensive Markdown parsing, highlighting, and result stringification. */
export declare class NavigatorTextRenderCache {
    private readonly entries;
    private readonly resultJson;
    private weight;
    get(key: string): string[] | undefined;
    stringify(result: object): string;
    set(key: string, lines: string[], weight: number): string[];
}
