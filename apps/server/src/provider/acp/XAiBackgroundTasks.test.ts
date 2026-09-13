import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import {
  buildGrokBackgroundTaskEvents,
  buildGrokTaskCompletedEvents,
  type GrokBackgroundTaskRecord,
} from "./XAiBackgroundTasks.ts";

const turnId = TurnId.make("turn-1");
const monitor = { type: "Monitor", taskId: "monitor-1", timeoutMs: 60_000 };
const shell = { type: "BackgroundTaskStarted", task_id: "shell-1", command: "sleep 40" };

function mapper() {
  const tasks = new Map<string, GrokBackgroundTaskRecord>();
  const update = (
    rawOutput: unknown,
    overrides: Partial<Parameters<typeof buildGrokBackgroundTaskEvents>[0]> = {},
  ) =>
    buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-1",
      rawInput: { description: "Watch" },
      rawOutput,
      toolCallStatus: "completed",
      turnId,
      ...overrides,
    });
  return { tasks, update };
}

describe("Grok background tasks", () => {
  it.each([
    [monitor, "monitor-1", "monitor", "Watch"],
    [shell, "shell-1", "shell", "sleep 40"],
  ] as const)("starts and deduplicates %j", (output, id, taskType, description) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([
      {
        type: "task.started",
        turnId,
        payload: { taskId: id, taskType, description, title: description, toolUseId: "call-1" },
      },
    ]);
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("accepts automatic backgrounding before the tool becomes terminal", () => {
    const { update } = mapper();
    expect(update(shell, { toolCallStatus: "inProgress" })[0]?.type).toBe("task.started");
    expect(update(monitor, { toolCallStatus: "inProgress" })).toEqual([]);
    expect(update(monitor, { toolCallStatus: "failed" })).toEqual([]);
  });

  it.each([
    ["running", null, "task.progress", undefined],
    ["pending", null, "task.progress", undefined],
    ["completed", 0, "task.completed", "completed"],
    ["success", 0, "task.completed", "completed"],
    ["succeeded", 0, "task.completed", "completed"],
    ["failed", 1, "task.completed", "failed"],
    ["error", 1, "task.completed", "failed"],
    ["stopped", 137, "task.completed", "stopped"],
    ["killed", 137, "task.completed", "stopped"],
    ["cancelled", 137, "task.completed", "stopped"],
    [undefined, 0, "task.completed", "completed"],
    [undefined, 1, "task.completed", "failed"],
  ])("maps poll status %s / exit %s", (status, exit_code, type, expectedStatus) => {
    const { tasks, update } = mapper();
    update(monitor);
    const events = update({
      type: "TaskOutput",
      Result: {
        task_id: "monitor-1",
        command: "[monitor:Watch]",
        status,
        exit_code,
        output: "\n result\nmore",
      },
    });
    expect(events).toEqual([
      {
        type,
        turnId,
        payload: {
          taskId: "monitor-1",
          taskType: "monitor",
          description: "Watch",
          title: "Watch",
          toolUseId: "call-1",
          summary: "result",
          ...(expectedStatus ? { status: expectedStatus } : {}),
        },
      },
    ]);
    expect(tasks.size).toBe(type === "task.progress" ? 1 : 0);
  });

  it.each([undefined, TurnId.make("turn-2")])(
    "does not attribute old tasks to a later turn: %s",
    (laterTurnId) => {
      const { tasks, update } = mapper();
      update(shell);
      const events = update(
        {
          type: "TaskOutput",
          Result: { task_id: "shell-1", command: "sleep 40", status: "completed" },
        },
        { turnId: laterTurnId },
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.turnId).toBeUndefined();
      expect(tasks.size).toBe(0);
    },
  );

  it("starts unknown poll tasks before progress or completion and ignores subagents", () => {
    const { tasks, update } = mapper();
    const events = update({
      type: "TaskOutput",
      MultiResult: {
        results: [
          { task_id: "shell-1", command: "sleep 40", status: "running" },
          { task_id: "monitor-1", command: "[monitor] Watch", status: "completed" },
          { task_id: "agent-1", command: "[subagent:executor] work", status: "running" },
        ],
      },
    });
    expect(events.map(({ type }) => type)).toEqual([
      "task.started",
      "task.progress",
      "task.started",
      "task.completed",
    ]);
    expect(events.map(({ payload }) => payload.taskType)).toEqual([
      "shell",
      "shell",
      "monitor",
      "monitor",
    ]);
    expect([...tasks.keys()]).toEqual(["shell-1"]);
    expect(events.map((event) => event.turnId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("retires only successfully killed tasks, including mixed results", () => {
    const { tasks, update } = mapper();
    update(shell);
    update(monitor);
    const result = { type: "KillTask", Result: { task_id: "shell-1", outcome: "killed" } };
    expect(update(result, { toolCallStatus: "failed" })).toEqual([]);
    expect(tasks.size).toBe(2);
    const events = update({
      type: "KillTask",
      MultiResult: {
        results: [
          result.Result,
          { task_id: "monitor-1", outcome: "error" },
          { task_id: "unknown", outcome: "killed" },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        turnId,
        payload: {
          taskId: "shell-1",
          taskType: "shell",
          description: "sleep 40",
          title: "sleep 40",
          toolUseId: "call-1",
          status: "stopped",
        },
      },
    ]);
    expect([...tasks.keys()]).toEqual(["monitor-1"]);
  });

  it.each([
    null,
    [],
    {},
    { type: "Text", text: "subagent_id: fake\ntype: executor\ndescription: fake" },
    { type: "Monitor", taskId: " " },
    { type: "BackgroundTaskStarted", task_id: "shell-1" },
    {
      type: "TaskOutput",
      MultiResult: {
        results: [null, {}, { task_id: "task", command: "sleep 40", exit_code: Infinity }],
      },
    },
  ])("ignores malformed or unrelated outputs: %j", (output) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(0);
  });
});

describe("Grok task_completed notices", () => {
  const monitorTaskId = "01a074d8-7c7f-7903-991f-1c9276e6e058";
  const monitorDescription = "Watch t3-plan draft until DONE/FAILED";

  function taskCompletedNotice(
    overrides: {
      task_id?: string;
      exit_code?: number | null;
      signal?: string | null;
      explicitly_killed?: boolean;
      completed?: boolean;
      output?: string;
      kind?: string;
    } = {},
  ) {
    return {
      sessionId: "01a074d2-6fe5-79a2-8e2c-85686250e5ee",
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: monitorTaskId,
          command: "python3 /tmp/example/watch.py --unit t3-draft",
          display_command: `[monitor] ${monitorDescription}`,
          description: monitorDescription,
          kind: "monitor",
          exit_code: 0,
          signal: null,
          explicitly_killed: false,
          completed: true,
          is_backgrounded: true,
          output: "DONE t3-draft\n",
          start_time: 1_788_666_700.1,
          end_time: 1_788_666_972.0,
          ...overrides,
        },
        will_wake: true,
      },
    };
  }

  function seedMonitor(tasks: Map<string, GrokBackgroundTaskRecord>, taskTurnId = turnId) {
    buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-1",
      rawInput: { description: monitorDescription },
      rawOutput: { type: "Monitor", taskId: monitorTaskId, timeoutMs: 60_000 },
      toolCallStatus: "completed",
      turnId: taskTurnId,
    });
  }

  it("completes a known monitor from a task_completed notice", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice(),
      turnId: TurnId.make("turn-2"),
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: monitorTaskId,
          taskType: "monitor",
          description: monitorDescription,
          title: monitorDescription,
          toolUseId: "call-1",
          status: "completed",
          summary: "DONE t3-draft",
        },
      },
    ]);
    expect(tasks.size).toBe(0);
  });

  it("maps a non-zero exit code to failed", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice({ exit_code: 1, output: "FAILED pages\n" }),
    });
    const completed = events.find((event) => event.type === "task.completed");
    expect(completed?.payload.status).toBe("failed");
    expect(tasks.size).toBe(0);
  });

  it("maps explicitly killed bash tasks to stopped", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice({
        kind: "bash",
        exit_code: null,
        signal: "killed",
        explicitly_killed: true,
        output: "",
      }),
    });
    const completed = events.find((event) => event.type === "task.completed");
    expect(completed?.payload.status).toBe("stopped");
    expect(tasks.size).toBe(0);
  });

  it("ignores incomplete snapshots", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice({ completed: false }),
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("ignores unknown task ids without starting a task", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice({ task_id: "unknown-task" }),
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it("ignores unrelated session/update kinds", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("deduplicates dual delivery across both methods", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const notice = taskCompletedNotice();
    const first = buildGrokTaskCompletedEvents({ tasks, notification: notice });
    const second = buildGrokTaskCompletedEvents({ tasks, notification: notice });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it.each([
    [TurnId.make("turn-2"), undefined],
    [turnId, turnId],
  ])(
    "attributes completion to the originating turn only when it matches: %s",
    (noticeTurnId, expectedTurnId) => {
      const tasks = new Map<string, GrokBackgroundTaskRecord>();
      seedMonitor(tasks);
      const events = buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice(),
        turnId: noticeTurnId,
      });
      expect(events[0]?.turnId).toBe(expectedTurnId);
    },
  );
});
