// The lists scripts/pack-release.mjs packs by, for tests/unit/pack-release.test.ts.
export declare const APP_FILES: string[];
export declare const LEFT_OUT: string[];
export declare const PACKAGES: Record<string, string[]>;
export declare const ENTRIES: string[];
export declare function ships(file: string): boolean;
export declare function specifiers(text: string): string[];
export declare function provided(spec: string): boolean;
export declare const RUNTIME_EPOCH: string;
export interface RuntimePart {
  kind: "electron" | "syncthing";
  relative: string;
  name: string;
  dir: string;
}
export declare function runtimeParts(stage: string, versions: { arch: string; electron: string; syncthing: string }): RuntimePart[];
export declare function manifestFor(opts: { version: string; arch: string; parts: Array<{ kind: string; name: string; dir: string }>; treeHash: (dir: string) => string }): string;
export declare function treeHash(dir: string, installer?: string): string;
