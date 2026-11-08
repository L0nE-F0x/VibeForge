// The lists scripts/pack-release.mjs packs by, for tests/unit/pack-release.test.ts.
export declare const APP_FILES: string[];
export declare const PACKAGES: Record<string, string[]>;
export declare const ENTRIES: string[];
export declare function ships(file: string): boolean;
export declare function specifiers(text: string): string[];
export declare function provided(spec: string): boolean;
