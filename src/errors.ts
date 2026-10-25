/** An error carrying the HTTP status a route should answer with. */
export const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });

export function errorInfo(error: unknown): { message: string; status?: number; code?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    message: error.message,
    status: 'status' in error && typeof error.status === 'number' ? error.status : undefined,
    code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
  };
}
