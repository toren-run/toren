export type StreamId = "run" | `task:${string}`;

export type EventType =
  | "RunCreated" | "RunStarted" | "SideEffectRecorded" | "TimerSet" | "TimerFired"
  | "WavePlanned" | "WaveDispatched" | "WaveTaskSettled" | "WaveSettled"
  | "RunCompleted" | "RunFailed" | "RunCancelled"
  | "TaskStarted" | "LlmCallStarted" | "LlmCallCompleted"
  | "ToolCallStarted" | "ToolCallCompleted"
  | "ApprovalRequested" | "ApprovalResolved"
  | "StreamInvalidated"
  | "TaskCompleted" | "TaskFailed"
  | "InputRequested" | "UserMessage";

export interface NewEvent { type: EventType; payload: Record<string, unknown> & { v: 1 } }
export interface RecordedEvent extends NewEvent { seq: number; recordedAt: Date }

export const ev = (type: EventType, payload: Record<string, unknown>): NewEvent =>
  ({ type, payload: { v: 1, ...payload } });

export function isInvalidation(e: RecordedEvent): e is RecordedEvent & { payload: { v: 1; fromSeq: number; reason: string } } {
  return e.type === "StreamInvalidated" && typeof e.payload.fromSeq === "number";
}
