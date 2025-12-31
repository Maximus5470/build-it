/**
 * Optimus Code Execution Engine - Type Definitions
 * 
 * Type-safe interfaces for the Optimus backend API.
 */

// ============================================================================
// LANGUAGE & BASIC TYPES
// ============================================================================

export type Language = 'python' | 'java';

export type JobStatus = 
  | 'completed' 
  | 'failed' 
  | 'timedout' 
  | 'cancelled'
  | 'pending';

export type TestStatus = 
  | 'passed' 
  | 'failed' 
  | 'runtimeerror' 
  | 'timelimitexceeded';

// ============================================================================
// REQUEST INTERFACES
// ============================================================================

export interface TestCase {
  input: string;
  expected_output: string;
  weight?: number; // Optional, defaults to 10 on backend
}

export interface SubmitJobRequest {
  language: Language;
  source_code: string;
  test_cases: TestCase[];
  timeout_ms?: number; // Optional, defaults to 5000, max 60000
}

// ============================================================================
// RESPONSE INTERFACES
// ============================================================================

export interface SubmitJobResponse {
  job_id: string; // UUID format
}

export interface TestResult {
  test_id: number;
  status: TestStatus;
  stdout: string;
  stderr: string;
  execution_time_ms: number;
}

export interface ExecutionResult {
  job_id: string;
  overall_status: Exclude<JobStatus, 'pending'>;
  score: number;
  max_score: number;
  results: TestResult[];
}

export interface PendingJobResponse {
  job_id: string;
  status: 'pending';
  message: string;
}

export type JobResultResponse = ExecutionResult | PendingJobResponse;

// ============================================================================
// ERROR INTERFACES
// ============================================================================

export interface ApiErrorDetail {
  code: string;
  message: string;
}

export interface ApiErrorResponse {
  error: ApiErrorDetail;
}

export type ApiErrorCode =
  | 'NO_TEST_CASES'
  | 'TOO_MANY_TEST_CASES'
  | 'SOURCE_CODE_TOO_LARGE'
  | 'EMPTY_SOURCE_CODE'
  | 'TEST_CASE_INPUT_TOO_LARGE'
  | 'TEST_CASE_OUTPUT_TOO_LARGE'
  | 'INVALID_TIMEOUT'
  | 'LANGUAGE_NOT_SUPPORTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUEUE_FAILURE'
  | 'INVALID_JOB_ID'
  | 'INTERNAL_ERROR';

// ============================================================================
// CANCEL JOB INTERFACES
// ============================================================================

export interface CancelJobResponse {
  job_id: string;
  status: string;
  message: string;
}

// ============================================================================
// HEALTH CHECK INTERFACES
// ============================================================================

export interface HealthCheckResponse {
  status: string;
  uptime_seconds: number;
  redis_connected: boolean;
  timestamp: string; // ISO 8601 format
}

// ============================================================================
// VALIDATION CONSTRAINTS
// ============================================================================

export const VALIDATION_LIMITS = {
  SOURCE_CODE_MIN: 1,
  SOURCE_CODE_MAX: 256000, // 256 KB
  TEST_CASES_MIN: 1,
  TEST_CASES_MAX: 100,
  TEST_INPUT_MAX: 64000, // 64 KB
  TEST_OUTPUT_MAX: 64000, // 64 KB
  TIMEOUT_MIN: 1, // 1ms
  TIMEOUT_MAX: 60000, // 60 seconds
  TIMEOUT_DEFAULT: 5000, // 5 seconds
  WEIGHT_DEFAULT: 10,
} as const;

// ============================================================================
// UTILITY TYPE GUARDS
// ============================================================================

export function isExecutionResult(
  response: JobResultResponse
): response is ExecutionResult {
  return 'overall_status' in response;
}

export function isPendingResponse(
  response: JobResultResponse
): response is PendingJobResponse {
  return 'status' in response && response.status === 'pending';
}

export function isApiError(error: unknown): error is ApiErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as any).error === 'object' &&
    'code' in (error as any).error &&
    'message' in (error as any).error
  );
}
