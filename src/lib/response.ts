export function success<T>(data: T, message = "OK") {
  return {
    success: true,
    message,
    data,
  };
}

export function failure(message: string, code = "INTERNAL_ERROR", details?: unknown) {
  return {
    success: false,
    message,
    code,
    ...(details === undefined ? {} : { details }),
  };
}

