type Success<T> = { data: T; error: null };
type Failure<E> = { data: null; error: E };
type Result<T, E = Error> = Success<T> | Failure<E>;

function isPromiseLike<T>(value: any): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.then === 'function'
  );
}

/**
 * Runs a sync or async function and returns `{ data, error }`.
 * On success, the function's return value or resolved value is stored in `data`.
 * If the function only performs side effects, it may return `void`.
 * Always returns a Promise and must be awaited.
 *
 * @param fn Function to execute. May return a value, `void`, or a Promise.
 * @param errorMessage Optional custom error message
 * @param logError Whether to log the error to console (defaults to true)
 * @returns A Promise resolving to a Result object
 */
export async function tryCatch<T, E = Error>(
  fn: () => T | Promise<T>,
  errorMessage?: string,
  logError: boolean = true
): Promise<Result<T, E>> {
  if (typeof fn !== 'function') {
    throw new Error('tryCatch argument must be a function');
  }

  try {
    const result = fn();

    // If function returns a promise, handle it specially
    if (isPromiseLike<T>(result)) {
      try {
        return { data: await result, error: null };
      } catch (error) {
        return handleError(error as E, errorMessage, logError);
      }
    }

    // For synchronous results
    return { data: result, error: null };
  } catch (error) {
    return handleError(error as E, errorMessage, logError);
  }
}

/**
 * Common error handling logic.
 */
function handleError<E = Error>(
  error: E,
  errorMessage?: string,
  logError: boolean = true
): Failure<E> {
  if (logError) {
    const message = errorMessage
      ? `${errorMessage}: ${(error as Error).message ?? error}`
      : ((error as Error).message ?? error);
    console.error(message);
  }
  return { data: null, error };
}
