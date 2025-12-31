"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db";
import { examAssignments, submissions } from "@/db/schema/assignments";
import { questions, testCases } from "@/db/schema/questions";
import { auth } from "@/lib/auth";
import { calculateGradingScore } from "@/lib/grading";
import {
  executeAndWait,
  OptimusError,
} from "@/lib/optimus-client";
import type { Language, TestCase } from "@/types/optimus";

// ============================================
// Types
// ============================================

export interface SubmitQuestionInput {
  assignmentId: string;
  questionId: string;
  code: string;
  language: string;
}

export interface SubmitResult {
  success: boolean;
  verdict?: "passed" | "failed" | "compile_error" | "runtime_error";
  score?: number;
  testCasesPassed?: number;
  totalTestCases?: number;
  error?: string;
  details?: string; // Logic for more info (e.g. compilation error message)
}

// ============================================
// Server Action
// ============================================

export async function submitQuestion(
  input: SubmitQuestionInput,
): Promise<SubmitResult> {
  // 1. Auth Check
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return { success: false, error: "Unauthorized: Please sign in" };
  }

  try {
    // 2. Validate Assignment Ownership & Status
    const assignment = await db.query.examAssignments.findFirst({
      where: and(
        eq(examAssignments.id, input.assignmentId),
        eq(examAssignments.userId, session.user.id),
      ),
      with: {
        exam: true, // Fetch exam details for grading config
      },
    });

    if (!assignment) {
      return { success: false, error: "Assignment not found or unauthorized" };
    }

    if (assignment.status === "completed") {
      return { success: false, error: "Exam is already completed" };
    }

    // 3. Fetch Hidden Test Cases
    const hiddenTestCases = await db.query.testCases.findMany({
      where: and(
        eq(testCases.questionId, input.questionId),
        eq(testCases.isHidden, true),
      ),
    });

    // Fallback: If no hidden cases, use ALL cases
    let gradingTestCases = hiddenTestCases;
    if (gradingTestCases.length === 0) {
      gradingTestCases = await db.query.testCases.findMany({
        where: eq(testCases.questionId, input.questionId),
      });
    }

    if (gradingTestCases.length === 0) {
      return { success: false, error: "No test cases found for grading" };
    }

    // 4. Execute with Optimus
    const optimusTestCases: TestCase[] = gradingTestCases.map((tc) => ({
      input: tc.input,
      expected_output: tc.expectedOutput,
    }));

    console.log('[SubmitQuestion] Language:', input.language);
    console.log('[SubmitQuestion] Test cases count:', optimusTestCases.length);

    const execStart = Date.now();
    const executionResult = await executeAndWait({
      language: input.language.toLowerCase() as Language,
      source_code: input.code,
      test_cases: optimusTestCases,
      timeout_ms: 5000,
    });

    console.log('[SubmitQuestion] executeAndWait elapsed:', Date.now() - execStart, 'ms');
    console.log('[SubmitQuestion] Execution result:', {
      overall_status: executionResult.overall_status,
      score: executionResult.score,
      max_score: executionResult.max_score,
      results_count: executionResult.results.length,
    });

    // 5. Determine Verdict
    let verdict: "passed" | "failed" | "compile_error" | "runtime_error" =
      "failed";
    let passedCount = 0;
    let details = "";

    if (executionResult.overall_status === 'failed') {
      // overall_status 'failed' means some tests failed, not necessarily runtime error
      // Check if it's a compilation error by looking at stderr in first test
      const firstResult = executionResult.results[0];
      console.log('[SubmitQuestion] First test result:', {
        status: firstResult?.status,
        stdout: firstResult?.stdout,
        stderr: firstResult?.stderr,
      });
      
      // Only treat as compile_error if there's stderr and status is runtimeerror
      if (firstResult?.stderr && firstResult.status === 'runtimeerror') {
        verdict = "compile_error";
        details = firstResult.stderr;
      } else {
        // Count how many actually passed
        passedCount = executionResult.results.filter((r) => r.status === 'passed').length;
        
        // If all failed with runtime errors, it's a runtime error
        const allRuntimeErrors = executionResult.results.every(
          (r) => r.status === 'runtimeerror' || r.status === 'timelimitexceeded'
        );
        
        if (allRuntimeErrors) {
          verdict = "runtime_error";
          details = firstResult?.stderr || "Runtime error occurred";
        } else {
          // Some passed, some failed - just a failed submission
          verdict = "failed";
          if (passedCount === executionResult.results.length) {
            verdict = "passed";
          }
        }
      }
    } else if (executionResult.overall_status === 'timedout') {
      verdict = "runtime_error";
      details = "Time limit exceeded";
    } else if (executionResult.overall_status === 'completed') {
      // Check test cases
      passedCount = executionResult.results.filter((r) => r.status === 'passed').length;

      if (passedCount === gradingTestCases.length) {
        verdict = "passed";
      } else {
        verdict = "failed";
      }
    } else {
      // Handle other statuses like 'cancelled'
      verdict = "runtime_error";
      details = `Unexpected status: ${executionResult.overall_status}`;
    }

    // 6. Insert Submission
    await db.insert(submissions).values({
      assignmentId: input.assignmentId,
      questionId: input.questionId,
      language: input.language,
      code: input.code,
      verdict: verdict,
      testCasesPassed: passedCount,
      totalTestCases: gradingTestCases.length,
    });

    // 7. Calculate New Score based on Grading Strategy
    const assignedQuestionIds = assignment.assignedQuestionIds as string[];

    // Fetch all submissions for these questions to calculate best status
    const allSubmissions = await db.query.submissions.findMany({
      where: eq(submissions.assignmentId, input.assignmentId),
      columns: {
        questionId: true,
        testCasesPassed: true,
        totalTestCases: true,
        verdict: true,
      },
    });

    // Determine which questions are "passed" (fully solved) and calculate partial scores
    const passedQuestionIds = new Set<string>();
    const questionScores: Record<string, number> = {};

    for (const qId of assignedQuestionIds) {
      const qSubmissions = allSubmissions.filter((s) => s.questionId === qId);

      // Determine fully passed status
      const hasPassed = qSubmissions.some((s) => s.verdict === "passed");
      if (hasPassed) {
        passedQuestionIds.add(qId);
        questionScores[qId] = 1; // 100%
      } else {
        // Calculate best partial score
        // We find the max ratio of (testCasesPassed / totalTestCases) across all submissions
        let maxRatio = 0;
        for (const s of qSubmissions) {
          if (s.totalTestCases && s.totalTestCases > 0) {
            const ratio = (s.testCasesPassed || 0) / s.totalTestCases;
            if (ratio > maxRatio) {
              maxRatio = ratio;
            }
          }
        }
        questionScores[qId] = maxRatio;
      }
    }

    const gradingStrategy = assignment.exam.gradingStrategy;
    const gradingConfig = assignment.exam.gradingConfig as any;
    const questionDifficulties: Record<string, "easy" | "medium" | "hard"> = {};

    if (gradingStrategy === "difficulty_based") {
      const questionDetails = await db.query.questions.findMany({
        where: inArray(questions.id, assignedQuestionIds),
        columns: {
          id: true,
          difficulty: true,
        },
      });
      questionDetails.forEach((q) => {
        questionDifficulties[q.id] = q.difficulty;
      });
    }

    const newScore = calculateGradingScore({
      strategy: gradingStrategy,
      config: gradingConfig,
      passedQuestionIds: Array.from(passedQuestionIds),
      questionDifficulties,
      questionScores,
    });

    // Score is monotonically increasing - only update if new score is higher
    if (newScore > (assignment.score || 0)) {
      await db
        .update(examAssignments)
        .set({ score: newScore })
        .where(eq(examAssignments.id, input.assignmentId));
    }

    revalidatePath(`/exams/${assignment.examId}`);

    return {
      success: true,
      verdict,
      score: Math.max(newScore, assignment.score || 0),
      testCasesPassed: passedCount,
      totalTestCases: gradingTestCases.length,
      details,
    };
  } catch (error) {
    console.error("Submission error:", error);
    if (error instanceof OptimusError) {
      return {
        success: false,
        error: `Execution Engine Error: ${error.message}`,
      };
    }
    return { success: false, error: "Failed to process submission" };
  }
}
