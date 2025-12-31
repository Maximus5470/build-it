/**
 * Optimus Code Execution Engine - API Client
 * 
 * Modular client for interacting with the Optimus backend.
 * Handles job submission, polling, cancellation, and error handling.
 */

import type {
  SubmitJobRequest,
  SubmitJobResponse,
  JobResultResponse,
  ExecutionResult,
  ApiErrorResponse,
  CancelJobResponse,
  HealthCheckResponse,
  VALIDATION_LIMITS,
} from '@/types/optimus';
import { isExecutionResult, isPendingResponse, isApiError } from '@/types/optimus';
import { VALIDATION_LIMITS as LIMITS } from '@/types/optimus';

// ============================================================================
// CONFIGURATION
// ============================================================================

const OPTIMUS_API_BASE_URL = 
  process.env.OPTIMUS_API_BASE_URL || 
  process.env.NEXT_PUBLIC_OPTIMUS_API_BASE_URL || 
  'http://127.0.0.1:80';

const POLLING_CONFIG = {
  INITIAL_DELAY_MS: 100, // Reduced from 500ms for faster response
  MAX_DELAY_MS: 3000, // Reduced from 5000ms
  BACKOFF_MULTIPLIER: 1.5,
  MAX_ATTEMPTS: 60, // ~5 minutes with exponential backoff
} as const;

// ============================================================================
// ERROR HANDLING
// ============================================================================

export class OptimusError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'OptimusError';
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

export interface ValidationError {
  field: string;
  message: string;
}

export function validateSubmitRequest(
  request: SubmitJobRequest
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate source code
  const codeSize = new TextEncoder().encode(request.source_code).length;
  if (codeSize < LIMITS.SOURCE_CODE_MIN) {
    errors.push({ field: 'source_code', message: 'Source code cannot be empty' });
  }
  if (codeSize > LIMITS.SOURCE_CODE_MAX) {
    errors.push({
      field: 'source_code',
      message: `Source code exceeds ${LIMITS.SOURCE_CODE_MAX} bytes`,
    });
  }

  // Validate test cases
  if (!request.test_cases || request.test_cases.length < LIMITS.TEST_CASES_MIN) {
    errors.push({
      field: 'test_cases',
      message: `At least ${LIMITS.TEST_CASES_MIN} test case is required`,
    });
  }
  if (request.test_cases && request.test_cases.length > LIMITS.TEST_CASES_MAX) {
    errors.push({
      field: 'test_cases',
      message: `Maximum ${LIMITS.TEST_CASES_MAX} test cases allowed`,
    });
  }

  // Validate each test case
  request.test_cases?.forEach((tc, index) => {
    const inputSize = new TextEncoder().encode(tc.input).length;
    const outputSize = new TextEncoder().encode(tc.expected_output).length;

    if (inputSize > LIMITS.TEST_INPUT_MAX) {
      errors.push({
        field: `test_cases[${index}].input`,
        message: `Test case input exceeds ${LIMITS.TEST_INPUT_MAX} bytes`,
      });
    }
    if (outputSize > LIMITS.TEST_OUTPUT_MAX) {
      errors.push({
        field: `test_cases[${index}].expected_output`,
        message: `Test case output exceeds ${LIMITS.TEST_OUTPUT_MAX} bytes`,
      });
    }
  });

  // Validate timeout
  if (request.timeout_ms !== undefined) {
    if (request.timeout_ms < LIMITS.TIMEOUT_MIN) {
      errors.push({
        field: 'timeout_ms',
        message: `Timeout must be at least ${LIMITS.TIMEOUT_MIN}ms`,
      });
    }
    if (request.timeout_ms > LIMITS.TIMEOUT_MAX) {
      errors.push({
        field: 'timeout_ms',
        message: `Timeout cannot exceed ${LIMITS.TIMEOUT_MAX}ms`,
      });
    }
  }

  return errors;
}

// ============================================================================
// CORE API FUNCTIONS
// ============================================================================

/**
 * Submit a code execution job to Optimus.
 */
export async function submitJob(
  request: SubmitJobRequest,
  idempotencyKey?: string
): Promise<SubmitJobResponse> {
  // Validate request
  const validationErrors = validateSubmitRequest(request);
  if (validationErrors.length > 0) {
    throw new OptimusError(
      `Validation failed: ${validationErrors.map(e => `${e.field}: ${e.message}`).join(', ')}`,
      'VALIDATION_ERROR'
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  try {
    const submitStart = Date.now();
    const response = await fetch(`${OPTIMUS_API_BASE_URL}/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    console.log('[Optimus] submitJob fetch elapsed:', Date.now() - submitStart, 'ms');

    if (!response.ok) {
      await handleApiError(response);
    }

    const data: SubmitJobResponse = await response.json();
    return data;
  } catch (error) {
    console.error('[Optimus] Submit error:', error);
    if (error instanceof OptimusError) {
      throw error;
    }
    throw new OptimusError(
      error instanceof Error ? error.message : 'Failed to submit job',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Get the result of a job by job ID.
 */
export async function getJobResult(jobId: string): Promise<JobResultResponse> {
  try {
    const response = await fetch(`${OPTIMUS_API_BASE_URL}/job/${jobId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    const data: JobResultResponse = await response.json();
    return data;
  } catch (error) {
    if (error instanceof OptimusError) {
      throw error;
    }
    throw new OptimusError(
      error instanceof Error ? error.message : 'Failed to get job result',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Poll for job result with exponential backoff.
 */
export async function pollJobResult(
  jobId: string,
  onProgress?: (attempt: number, delay: number) => void
): Promise<ExecutionResult> {
  const pollingStart = Date.now();
  let attempt = 0;
  let delay: number = 0; // Start with 0 delay for immediate first check

  while (attempt < POLLING_CONFIG.MAX_ATTEMPTS) {
    attempt++;
    
    if (onProgress) {
      onProgress(attempt, delay);
    }

    // Wait before polling (no wait on first attempt)
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      const result = await getJobResult(jobId);

      if (isExecutionResult(result)) {
        console.log('[Optimus] pollJobResult total polling elapsed:', Date.now() - pollingStart, 'ms');
        return result;
      }

      // Still pending, start/continue exponential backoff
      delay = delay === 0 
        ? POLLING_CONFIG.INITIAL_DELAY_MS 
        : Math.min(
            delay * POLLING_CONFIG.BACKOFF_MULTIPLIER,
            POLLING_CONFIG.MAX_DELAY_MS
          );
    } catch (error) {
      // If it's a 404, the job might not exist
      if (error instanceof OptimusError && error.statusCode === 404) {
        throw error;
      }
      // For other errors, retry
      console.warn(`Polling attempt ${attempt} failed:`, error);
    }
  }

  throw new OptimusError(
    'Job execution timeout - exceeded maximum polling attempts',
    'POLLING_TIMEOUT'
  );
}

/**
 * Submit a job and poll for the result.
 */
export async function executeAndWait(
  request: SubmitJobRequest,
  onProgress?: (attempt: number, delay: number) => void
): Promise<ExecutionResult> {
  const idempotencyKey = generateIdempotencyKey();
  const submitResponse = await submitJob(request, idempotencyKey);
  return pollJobResult(submitResponse.job_id, onProgress);
}

/**
 * Cancel a running job.
 */
export async function cancelJob(jobId: string): Promise<CancelJobResponse> {
  try {
    const response = await fetch(`${OPTIMUS_API_BASE_URL}/job/${jobId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    const data: CancelJobResponse = await response.json();
    return data;
  } catch (error) {
    if (error instanceof OptimusError) {
      throw error;
    }
    throw new OptimusError(
      error instanceof Error ? error.message : 'Failed to cancel job',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Check health status of Optimus API.
 */
export async function checkHealth(): Promise<HealthCheckResponse> {
  try {
    const response = await fetch(`${OPTIMUS_API_BASE_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new OptimusError(
        `Health check failed: ${response.status}`,
        'HEALTH_CHECK_FAILED',
        response.status
      );
    }

    const data: HealthCheckResponse = await response.json();
    return data;
  } catch (error) {
    if (error instanceof OptimusError) {
      throw error;
    }
    throw new OptimusError(
      error instanceof Error ? error.message : 'Health check failed',
      'NETWORK_ERROR'
    );
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate a UUID v4 idempotency key.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Handle API error responses.
 */
async function handleApiError(response: Response): Promise<never> {
  let errorData: ApiErrorResponse | null = null;
  
  try {
    errorData = await response.json();
  } catch {
    // Response is not JSON
  }

  if (errorData && isApiError(errorData)) {
    throw new OptimusError(
      errorData.error.message,
      errorData.error.code,
      response.status
    );
  }

  throw new OptimusError(
    `API request failed: ${response.status} ${response.statusText}`,
    'API_ERROR',
    response.status
  );
}

/**
 * Map test status to human-readable message.
 */
export function getTestStatusMessage(status: string): string {
  const messages: Record<string, string> = {
    passed: 'Passed',
    failed: 'Failed',
    runtimeerror: 'Runtime Error',
    timelimitexceeded: 'Time Limit Exceeded',
  };
  return messages[status.toLowerCase()] || status;
}

/**
 * Calculate execution statistics from result.
 */
export function getExecutionStats(result: ExecutionResult) {
  const totalTests = result.results.length;
  const passedTests = result.results.filter(r => r.status === 'passed').length;
  const failedTests = result.results.filter(r => r.status === 'failed').length;
  const errorTests = result.results.filter(r => 
    r.status === 'runtimeerror' || r.status === 'timelimitexceeded'
  ).length;
  const avgExecutionTime = totalTests > 0
    ? result.results.reduce((sum, r) => sum + r.execution_time_ms, 0) / totalTests
    : 0;

  return {
    totalTests,
    passedTests,
    failedTests,
    errorTests,
    avgExecutionTime,
    score: result.score,
    maxScore: result.max_score,
    percentage: result.max_score > 0 ? (result.score / result.max_score) * 100 : 0,
  };
}
