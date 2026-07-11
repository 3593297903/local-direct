export const PROJECT_SAVE_ERROR_CODES = [
  "PROJECT_LOCK_BUSY",
  "PROJECT_API_UNAVAILABLE",
  "PROJECT_VALIDATION_FAILED",
  "PROJECT_DB_SAVE_FAILED",
  "PROJECT_VERSION_CONFLICT",
] as const;

export type ProjectSaveErrorCode = (typeof PROJECT_SAVE_ERROR_CODES)[number];

export type ProjectSaveFailure = {
  saved: false;
  errorCode: ProjectSaveErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
};

export type ProjectSaveSuccess = {
  saved: true;
  projectId: string;
  versionId: string;
  versionNumber: number;
  idempotentReplay: boolean;
  requestId: string;
};

export type ProjectSaveResult = ProjectSaveSuccess | ProjectSaveFailure;

export function isProjectSaveErrorCode(value: unknown): value is ProjectSaveErrorCode {
  return typeof value === "string" && PROJECT_SAVE_ERROR_CODES.includes(value as ProjectSaveErrorCode);
}
