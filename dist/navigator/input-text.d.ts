/** Sanitizes text typed or pasted into the navigator's filter and rename fields. */
/** Remove terminal control sequences while preserving ordinary pasted text. */
export declare function safeInputText(data: string): string;
/** Backspace by one user-perceived character, so emoji and combining marks go in one keypress. */
export declare function dropLastGrapheme(text: string): string;
