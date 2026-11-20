// What scripts/fetch-syncthing.mjs offers, for tests/unit/pack-release.test.ts.
export interface Build {
  file: string;
  sha256: string;
}
export interface Pin {
  version: string;
  license: string;
  source: string;
  builds: Record<string, Build>;
}
export declare const RELEASE_KEY: string;
export declare const VENDOR_DIR: string;
export declare function pinned(): Pin;
export declare function mark(pin: Pin, arch: string): string;
export declare function present(dir: string, pin: Pin, arch: string): boolean;
export declare function sourceNote(pin: Pin): string;
export declare function parseSums(text: string, version: string): Record<string, Build>;
export declare function verifiedSums(sums: Buffer, keyText: Buffer, expectedKey?: string): string;
export declare function fetchSyncthing(options?: { dir?: string; arch?: string; say?: (line: string) => void }): Promise<"present" | "fetched">;
