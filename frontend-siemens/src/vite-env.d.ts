/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVE_CONTOURS: string | undefined;
  readonly VITE_REQUIRE_AUTH: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
