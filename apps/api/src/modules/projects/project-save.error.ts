import { HttpException } from "@nestjs/common";

export type ProjectSaveErrorCode =
  | "PROJECT_LOCK_BUSY"
  | "PROJECT_API_UNAVAILABLE"
  | "PROJECT_VALIDATION_FAILED"
  | "PROJECT_DB_SAVE_FAILED"
  | "PROJECT_VERSION_CONFLICT";

export class ProjectSaveException extends HttpException {
  readonly errorCode: ProjectSaveErrorCode;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(input: {
    code: ProjectSaveErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
    status: number;
  }) {
    super(
      {
        saved: false,
        errorCode: input.code,
        message: input.message,
        retryable: input.retryable,
        requestId: input.requestId,
      },
      input.status,
    );
    this.errorCode = input.code;
    this.retryable = input.retryable;
    this.requestId = input.requestId;
  }
}
