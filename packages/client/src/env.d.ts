/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WebSocket origin of the deployed worker, e.g. `wss://air-hockey.you.workers.dev`.
   *
   * Optional. Without it the client falls back to a local worker, and the
   * spectator and vs-bot modes never need a server at all.
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
