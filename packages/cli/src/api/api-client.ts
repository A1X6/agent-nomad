import type {
  BundleParams,
  DeleteAccountRequest,
  ListBundlesResponse,
  LoginRequest,
  LoginResponse,
  PreloginRequest,
  PreloginResponse,
  PutBundleResponse,
  RegisterRequest,
  SessionResponse,
} from '@agentnomad/contracts';

/** Account and session endpoints. Logout and account delete use the stored session token. */
export interface AuthApi {
  prelogin(request: PreloginRequest): Promise<PreloginResponse>;
  register(request: RegisterRequest): Promise<SessionResponse>;
  login(request: LoginRequest): Promise<LoginResponse>;
  logout(): Promise<void>;
  deleteAccount(request: DeleteAccountRequest): Promise<void>;
}

export interface ListBundlesOptions {
  readonly cursor?: string;
  /** 1–100; the server defaults to 50. */
  readonly limit?: number;
}

/** An encrypted bundle to upload. The ciphertext starts with its 24-byte nonce. */
export interface BundleUpload {
  readonly ciphertext: Uint8Array;
  /** Revision last seen; `0` to create a new saved setup. */
  readonly expectedRevision: number;
  /** Lowercase hex SHA-256 of `ciphertext`; lets a retried upload be recognised. */
  readonly contentSha256: string;
  readonly formatVersion: number;
  /** Base64 encrypted project name; omitted for the global scope. */
  readonly nameEnc?: string;
}

/** An encrypted bundle as downloaded. */
export interface DownloadedBundle {
  readonly ciphertext: Uint8Array;
  readonly revision: number;
  readonly contentSha256: string;
  readonly formatVersion: number;
  readonly nameEnc: string | null;
}

/** Saved-setup endpoints. All need a session. */
export interface BundlesApi {
  list(options?: ListBundlesOptions): Promise<ListBundlesResponse>;
  get(params: BundleParams): Promise<DownloadedBundle>;
  put(params: BundleParams, upload: BundleUpload): Promise<PutBundleResponse>;
  delete(params: BundleParams): Promise<void>;
}

/**
 * The only way the CLI talks to the server (T21): strict timeouts, retries with backoff on
 * network errors only (never on 4xx), and every response checked against the shared
 * contracts. Error responses reject with the API's error code.
 */
export interface ApiClient {
  readonly auth: AuthApi;
  readonly bundles: BundlesApi;
}
