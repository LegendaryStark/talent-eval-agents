import { describe, expect, it } from "vitest";

import {
  getComposerPolicy,
  initialRunView,
  reduceRunEvent,
  shouldCloseStreamForEvent,
  type RunEvent,
} from "./talentRunState";

function event(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  timestamp = "2026-09-27T10:00:00.000Z",
): RunEvent {
  return {
    event_id: `run-1:${sequence}`,
    sequence,
    type,
    run_id: "run-1",
    timestamp,
    schema_version: "1.0",
    data,
  };
}

describe("reduceRunEvent", () => {
  it("ignores duplicate or older events after reconnect", () => {
    const started = reduceRunEvent(
      initialRunView,
      event(2, "step.started", { step_id: "plan", title: "构建执行计划" }),
    );

    const duplicate = reduceRunEvent(
      started,
      event(2, "step.started", { step_id: "plan", title: "重复事件" }),
    );

    expect(duplicate).toBe(started);
    expect(duplicate.steps).toHaveLength(1);
  });

  it("updates one timeline row across start progress and completion", () => {
    const started = reduceRunEvent(
      initialRunView,
      event(3, "step.started", {
        step_id: "parallel",
        title: "并行评估候选人",
        total: 6,
      }, "2026-09-27T10:00:00.000Z"),
    );
    const progressed = reduceRunEvent(
      started,
      event(4, "step.progress", {
        step_id: "parallel",
        title: "并行评估候选人",
        completed: 4,
        total: 6,
      }),
    );
    const completed = reduceRunEvent(
      progressed,
      event(5, "step.completed", {
        step_id: "parallel",
        title: "并行评估候选人",
        summary: "6 个任务已完成",
        output: { status: "branches_ready", branch_count: 6 },
      }, "2026-09-27T10:00:02.500Z"),
    );

    expect(completed.steps).toHaveLength(1);
    expect(completed.steps[0]).toMatchObject({
      status: "completed",
      completed: 4,
      total: 6,
      summary: "6 个任务已完成",
      durationMs: 2500,
      output: { status: "branches_ready", branch_count: 6 },
    });
  });

  it("merges intermediate and final business output for one step", () => {
    const generated = reduceRunEvent(
      initialRunView,
      event(1, "step.progress", {
        step_id: "dimensions",
        title: "生成评估维度",
        output: { dimensions: [{ name: "Agent 评测" }], dimension_count: 1 },
      }),
    );
    const validated = reduceRunEvent(
      generated,
      event(2, "step.completed", {
        step_id: "dimensions",
        title: "生成评估维度",
        output: { status: "dimensions_valid", validation_issues: [] },
      }, "2026-09-27T10:00:00.200Z"),
    );

    expect(validated.steps[0].output).toEqual({
      dimensions: [{ name: "Agent 评测" }],
      dimension_count: 1,
      status: "dimensions_valid",
      validation_issues: [],
    });
  });

  it("freezes running steps when input is required and resumes their timers", () => {
    const started = reduceRunEvent(
      initialRunView,
      event(1, "step.started", { step_id: "plan", title: "理解人才要求" }, "2026-09-27T10:00:00.000Z"),
    );
    const waiting = reduceRunEvent(
      started,
      event(2, "hitl.required", { title: "确认岗位", options: [] }, "2026-09-27T10:00:01.200Z"),
    );
    const resumed = reduceRunEvent(
      waiting,
      event(3, "hitl.resolved", {}, "2026-09-27T10:00:03.000Z"),
    );
    const completed = reduceRunEvent(
      resumed,
      event(4, "step.completed", { step_id: "plan", title: "理解人才要求" }, "2026-09-27T10:00:03.800Z"),
    );

    expect(waiting.steps[0]).toMatchObject({ status: "paused", durationMs: 1200 });
    expect(resumed.steps[0].status).toBe("running");
    expect(completed.steps[0]).toMatchObject({ status: "completed", durationMs: 2000 });
  });

  it("stops every running animation when the run is cancelled", () => {
    const first = reduceRunEvent(
      initialRunView,
      event(1, "step.started", { step_id: "plan", title: "理解人才要求" }, "2026-09-27T10:00:00.000Z"),
    );
    const second = reduceRunEvent(
      first,
      event(2, "step.started", { step_id: "search", title: "筛选候选人" }, "2026-09-27T10:00:00.500Z"),
    );
    const cancelled = reduceRunEvent(
      second,
      event(3, "run.cancelled", {}, "2026-09-27T10:00:02.000Z"),
    );

    expect(cancelled.steps.map((step) => step.status)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled.steps.map((step) => step.durationMs)).toEqual([2000, 1500]);
  });

  it("marks a paused HITL step as cancelled when the run is cancelled", () => {
    const started = reduceRunEvent(
      initialRunView,
      event(1, "step.started", { step_id: "plan", title: "理解人才要求" }, "2026-09-27T10:00:00.000Z"),
    );
    const waiting = reduceRunEvent(
      started,
      event(2, "hitl.required", { title: "确认岗位", options: [] }, "2026-09-27T10:00:01.200Z"),
    );
    const cancelled = reduceRunEvent(
      waiting,
      event(3, "run.cancelled", {}, "2026-09-27T10:00:05.000Z"),
    );

    expect(cancelled.steps[0]).toMatchObject({ status: "cancelled", durationMs: 1200 });
  });

  it("locks and clears the composer while a run is active", () => {
    expect(getComposerPolicy("running")).toEqual({ disabled: true, showCancel: true });
    expect(getComposerPolicy("waiting_input")).toEqual({ disabled: true, showCancel: true });
    expect(getComposerPolicy("completed")).toEqual({ disabled: false, showCancel: false });
  });

  it("keeps SSE open during HITL and closes it only for terminal events", () => {
    expect(shouldCloseStreamForEvent("hitl.required")).toBe(false);
    expect(shouldCloseStreamForEvent("hitl.resolved")).toBe(false);
    expect(shouldCloseStreamForEvent("run.completed")).toBe(true);
    expect(shouldCloseStreamForEvent("run.failed")).toBe(true);
    expect(shouldCloseStreamForEvent("run.cancelled")).toBe(true);
  });

  it("stores interrupt report citations and terminal state", () => {
    const waiting = reduceRunEvent(
      initialRunView,
      event(6, "hitl.required", { title: "确认岗位", options: [] }),
    );
    const report = reduceRunEvent(
      waiting,
      event(7, "report.completed", {
        markdown: "# 报告",
        citations: [{ ref: "E1", quote: "证据" }],
        trace_id: "trace-1",
      }),
    );
    const done = reduceRunEvent(report, event(8, "run.completed", {}));

    expect(waiting.status).toBe("waiting_input");
    expect(report.report).toBe("# 报告");
    expect(report.citations[0].ref).toBe("E1");
    expect(done.status).toBe("completed");
    expect(done.interrupt).toBeNull();
  });
});
