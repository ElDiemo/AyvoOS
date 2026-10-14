export declare const POINTER_SUFFIX: string;
export declare const POINTER_MARKER: string;
export declare function pointerViolation(pointer: string): string | null;
export declare function createE2eStorage(
  pointer: string | undefined,
  options?: { root?: string },
): string;
