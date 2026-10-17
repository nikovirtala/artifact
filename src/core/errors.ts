// Typed error results returned by the core. Expected failures are values, not exceptions;
// storage I/O failures and programming errors still throw.

export type VersionConflict = {
  code: "version_conflict";
  message: string;
  currentVersion: number;
};

export type NotFound = {
  code: "not_found";
  message: string;
};

export type InvalidPath = {
  code: "invalid_path";
  message: string;
  path: string;
};

/** What a `too_large` limit applies to; `limit` is in bytes, files or characters accordingly. */
export type TooLargeSubject = "file" | "publish" | "file_count" | "label";

export type TooLarge = {
  code: "too_large";
  message: string;
  subject: TooLargeSubject;
  limit: number;
  path?: string;
};

export type ArtifactError = VersionConflict | NotFound | InvalidPath | TooLarge;

export type Result<T, E = ArtifactError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function fail<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export function versionConflict(currentVersion: number): VersionConflict {
  return {
    code: "version_conflict",
    message: `version conflict: current version is ${currentVersion}`,
    currentVersion,
  };
}

export function notFound(message: string): NotFound {
  return { code: "not_found", message };
}

export function invalidPath(path: string, reason: string): InvalidPath {
  return { code: "invalid_path", message: `invalid path ${JSON.stringify(path)}: ${reason}`, path };
}

export function tooLarge(subject: TooLargeSubject, limit: number, path?: string): TooLarge {
  const unit = subject === "file_count" ? "files" : subject === "label" ? "characters" : "bytes";
  const what = path === undefined ? subject.replace("_", " ") : `file ${JSON.stringify(path)}`;
  const error: TooLarge = {
    code: "too_large",
    message: `${what} exceeds the limit of ${limit} ${unit}`,
    subject,
    limit,
  };
  if (path !== undefined) error.path = path;
  return error;
}
