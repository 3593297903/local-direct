export type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}
