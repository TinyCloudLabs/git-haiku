/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_OPENKEY_HOST?: string;
  readonly VITE_TINYCLOUD_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
