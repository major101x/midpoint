/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public base URL of the FCC proxy, with no trailing slash.
   *
   * Only needed for a hosted build. In development the dev server forwards
   * `/tee` to localhost instead, so this is left unset.
   */
  readonly VITE_TEE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
