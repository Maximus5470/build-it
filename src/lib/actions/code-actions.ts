"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  executeAndWait,
  OptimusError,
  checkHealth,
} from "@/lib/optimus-client";
import type { Language, TestCase } from "@/types/optimus";
import type { TestcaseResult } from "@/types/problem";

// ============================================
// Types
// ============================================

export interface RunCodeInput {
  code: string;
  language: string;
  testCases: Array<{ id: string; input: string; expectedOutput: string }>;
}

export interface RunCodeResult {
  success: boolean;
  results?: TestcaseResult[];
  error?: string;
  compilationError?: string;
  executionTime?: number;
}

export interface RunCustomInput {
  code: string;
  language: string;
  stdin: string;
}

export interface RunCustomResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  compilationError?: string;
  executionTime?: number;
}

// ============================================
// Server Actions
// ============================================

/**
 * Run code against provided test cases using Optimus.
 * Used for the "Run" button to test against visible test cases.
 */
export async function runCode(input: RunCodeInput): Promise<RunCodeResult> {
  const serverStart = Date.now();

  // Auth check
  const authStart = Date.now();
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  const authElapsed = Date.now() - authStart;
  console.log('[RunCode] auth elapsed:', authElapsed, 'ms');

  if (!session?.user) {
    return { success: false, error: "Unauthorized: Please sign in" };
  }

  try {
    // Map test cases to Optimus format
    const testCases: TestCase[] = input.testCases.map((tc) => ({
      input: tc.input,
      expected_output: tc.expectedOutput,
    }));

    console.log('[RunCode] Language:', input.language);
    console.log('[RunCode] Test cases:', testCases.length);

    // Submit job and wait for result
    const execStart = Date.now();
    const result = await executeAndWait({
      language: input.language.toLowerCase() as Language,
      source_code: input.code,
      test_cases: testCases,
      timeout_ms: 5000,
    });
    console.log('[RunCode] executeAndWait elapsed:', Date.now() - execStart, 'ms');
    console.log('[RunCode] total server elapsed:', Date.now() - serverStart, 'ms');

    console.log('[RunCode] Execution result:', {
      overall_status: result.overall_status,
      score: result.score,
      max_score: result.max_score,
      results_count: result.results.length,
    });

    // Check overall status for compilation or runtime errors
    if (result.overall_status === 'failed') {
      // Check if any test has compilation-like errors in stderr
      const firstError = result.results[0];
      console.log('[RunCode] First test result:', {
        status: firstError?.status,
        stdout: firstError?.stdout,
        stderr: firstError?.stderr,
      });
      
      if (firstError?.stderr) {
        return {
          success: false,
          compilationError: firstError.stderr,
        };
      }
      return {
        success: false,
        error: 'Execution failed',
      };
    }

    // Handle timeout
    if (result.overall_status === 'timedout') {
      return {
        success: false,
        error: 'Execution timed out',
      };
    }

    // Handle cancelled
    if (result.overall_status === 'cancelled') {
      return {
        success: false,
        error: 'Execution was cancelled',
      };
    }

    // overall_status is 'completed' - process results
    // Map Optimus results to TestcaseResult format
    const testResults: TestcaseResult[] = result.results.map((tr, index) => ({
      id: input.testCases[index]?.id || `test-${tr.test_id}`,
      passed: tr.status === 'passed',
      input: input.testCases[index]?.input || '',
      expectedOutput: input.testCases[index]?.expectedOutput || '',
      actualOutput: tr.stdout.trim(),
      run_details: {
        stdout: tr.stdout,
        stderr: tr.stderr,
      },
    }));

    console.log('[Optimus] Mapped test results:', JSON.stringify(testResults, null, 2));

    // Calculate average execution time
    const avgExecTime = result.results.length > 0
      ? result.results.reduce((sum, r) => sum + r.execution_time_ms, 0) / result.results.length
      : 0;

    return {
      success: true,
      results: testResults,
      executionTime: avgExecTime,
    };
  } catch (error) {
    console.error("Code execution error:", error);

    if (error instanceof OptimusError) {
      return {
        success: false,
        error: `Execution service error: ${error.message}`,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to execute code",
    };
  }
}

/**
 * Run code with custom stdin input using Optimus.
 * Used for the "Custom Input" tab to test with user-provided input.
 */
export async function runWithCustomInput(
  input: RunCustomInput,
): Promise<RunCustomResult> {
  const serverStart = Date.now();

  // Auth check
  const authStart = Date.now();
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  console.log('[runWithCustomInput] auth elapsed:', Date.now() - authStart, 'ms');

  if (!session?.user) {
    return { success: false, error: "Unauthorized: Please sign in" };
  }

  try {
    // Create a single test case with the custom input
    const testCases: TestCase[] = [{
      input: input.stdin,
      expected_output: '', // No expected output for custom input
    }];

    const execStart = Date.now();
    const result = await executeAndWait({
      language: input.language.toLowerCase() as Language,
      source_code: input.code,
      test_cases: testCases,
      timeout_ms: 5000,
    });

    console.log('[runWithCustomInput] executeAndWait elapsed:', Date.now() - execStart, 'ms');
    console.log('[runWithCustomInput] total server elapsed:', Date.now() - serverStart, 'ms');

    // Get the first (and only) test result
    const testResult = result.results[0];

    if (!testResult) {
      return {
        success: false,
        error: 'No execution result received',
      };
    }

    // Check for runtime errors
    if (testResult.status === 'runtimeerror') {
      return {
        success: true,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
        executionTime: testResult.execution_time_ms,
      };
    }

    if (testResult.status === 'timelimitexceeded') {
      return {
        success: false,
        error: 'Time limit exceeded',
        stderr: testResult.stderr,
      };
    }

    return {
      success: true,
      stdout: testResult.stdout,
      stderr: testResult.stderr,
      executionTime: testResult.execution_time_ms,
    };
  } catch (error) {
    console.error("Custom input execution error:", error);

    if (error instanceof OptimusError) {
      return {
        success: false,
        error: `Execution service error: ${error.message}`,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to execute code",
    };
  }
}

/**
 * Check health status of the Optimus execution engine.
 */
export async function getRuntimes(): Promise<{
  success: boolean;
  runtimes?: Array<{ language: string; version: string }>;
  error?: string;
}> {
  try {
    const health = await checkHealth();
    
    if (health.status !== 'healthy') {
      return {
        success: false,
        error: 'Execution service is not healthy',
      };
    }

    // Optimus supports Python and Java
    const runtimes = [
      { language: 'python', version: '3.x' },
      { language: 'java', version: '11+' },
    ];

    return {
      success: true,
      runtimes,
    };
  } catch (error) {
    console.error("Failed to check execution service:", error);

    if (error instanceof OptimusError) {
      return {
        success: false,
        error: `Failed to connect to execution service: ${error.message}`,
      };
    }

    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to check service status",
    };
  }
}
