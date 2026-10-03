/** A file that exists on this PC and also arrives in a pulled bundle. */
export interface FileConflict {
  /** Bundle path, e.g. `settings.json`. */
  readonly path: string;
  readonly existing: Uint8Array;
  readonly incoming: Uint8Array;
}

/** A file the Restorer should write. Paths are bundle paths. */
export interface PlannedWrite {
  readonly path: string;
  readonly content: Uint8Array;
}

/**
 * Decides how to resolve one conflict (T11). Pure: it returns the files to write and never
 * touches the disk, so every case is easy to test.
 *
 * - `json-merge`: one merged file, keys from `incoming` win.
 * - `text-side-by-side`: the existing file stays; the incoming one is written next to it as a copy.
 * - `overwrite`: a backup of the existing file, then the incoming file.
 *
 * A merge for another format (TOML, Markdown sections) is one more strategy an agent's
 * restorer adds to its list; nothing here changes (SOLID-07).
 */
export interface MergeStrategy {
  /** e.g. `json-merge`; shown in tests and logs only. */
  readonly name: string;
  /** Whether this strategy can handle the file, e.g. `json-merge` only handles JSON. */
  appliesTo(path: string): boolean;
  resolve(conflict: FileConflict): readonly PlannedWrite[];
}
