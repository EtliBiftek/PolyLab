/** Bridge surface exposed by the Electron preload script (apps/desktop/src/preload.ts). */
export interface PolylabSidecarInfo {
  port: number;
  token: string;
}

export interface PolylabBridge {
  sidecar: PolylabSidecarInfo | null;
  versions: Record<string, string>;
  platform: string;
  selectFolder?: () => Promise<string | null>;
}

declare global {
  interface Window {
    polylab?: PolylabBridge;
  }
}

export {};
