export function success<T>(
  data: T,
  message = "요청이 성공적으로 처리되었습니다.",
  statusCode = 200,
) {
  return {
    success: true,
    data,
    message,
    statusCode,
  };
}

export function failure(
  message = "에러가 발생했습니다.",
  statusCode = 500,
  extras?: Record<string, unknown>,
) {
  return {
    success: false,
    data: null,
    message,
    statusCode,
    ...(extras || {}),
  };
}

export function legacyAuthFailure(
  message: string,
  code: string,
  error: string,
) {
  return {
    success: false,
    message,
    code,
    error,
  };
}

export function legacyHttpFailure(
  message: string,
  statusCode: number,
  path: string,
  method: string,
  extras?: Record<string, unknown>,
) {
  return {
    success: false,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
    path,
    method,
    ...(extras || {}),
  };
}

export function legacyValidationFailure(
  message: string,
  path: string,
  method: string,
  errors: Array<{ field: string; message: string; value?: unknown }>,
) {
  return legacyHttpFailure(message, 422, path, method, {
    code: "VALIDATION_ERROR",
    errors,
  });
}
