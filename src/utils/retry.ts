import { logger } from './logger';

interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 2000,
  maxDelay: 30000,
};

/**
 * Executes an async operation with exponential backoff retry.
 * @param operation - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the successful operation
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt > opts.maxRetries) {
        break;
      }

      const delay = Math.min(
        opts.baseDelay * Math.pow(2, attempt - 1),
        opts.maxDelay ?? 30000
      );

      logger.warn(
        { attempt, delay, error: lastError.message },
        'Operation failed, retrying...'
      );

      opts.onRetry?.(attempt, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
