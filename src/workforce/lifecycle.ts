import type {
  EmployeeWorkItem,
  ManagerReviewCycle,
  RecurringResponsibility,
  WorkItemStatus,
} from "./types.js";

const transitions: Record<WorkItemStatus, WorkItemStatus[]> = {
  queued: ["accepted", "cancelled", "escalated"],
  accepted: ["in_progress", "cancelled", "escalated"],
  in_progress: ["waiting", "review", "completed", "cancelled", "escalated"],
  waiting: ["in_progress", "cancelled", "escalated"],
  review: ["in_progress", "completed", "escalated"],
  escalated: ["accepted", "in_progress", "review", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!transitions[from].includes(to))
    throw new Error(`invalid work item transition: ${from} -> ${to}`);
}

export function workItemNeedsEscalation(item: EmployeeWorkItem, now: number): boolean {
  return (
    item.dueAt !== null &&
    item.dueAt <= now &&
    !["completed", "cancelled", "escalated"].includes(item.status)
  );
}

export function responsibilityOccurrenceKey(
  responsibility: Pick<RecurringResponsibility, "id" | "nextRunAt">,
): string {
  return `${responsibility.id}:${responsibility.nextRunAt}`;
}

export function nextResponsibilityRun(
  responsibility: Pick<
    RecurringResponsibility,
    "cadence" | "interval" | "weekday" | "monthDay" | "runAt"
  >,
  from: number,
): number {
  const date = new Date(from);
  const [hour, minute] = responsibility.runAt.split(":").map(Number);
  date.setUTCHours(hour ?? 0, minute ?? 0, 0, 0);
  if (responsibility.cadence === "daily")
    date.setUTCDate(date.getUTCDate() + responsibility.interval);
  else if (responsibility.cadence === "weekly") {
    date.setUTCDate(date.getUTCDate() + 7 * responsibility.interval);
    if (responsibility.weekday !== null) {
      date.setUTCDate(date.getUTCDate() + ((responsibility.weekday - date.getUTCDay() + 7) % 7));
    }
  } else {
    date.setUTCMonth(date.getUTCMonth() + responsibility.interval);
    date.setUTCDate(Math.min(responsibility.monthDay ?? 1, 28));
  }
  return date.getTime();
}

export function reviewCycleState(
  cycle: Pick<ManagerReviewCycle, "nextReviewAt" | "cadenceDays">,
  now: number,
): "scheduled" | "due" | "overdue" {
  if (now < cycle.nextReviewAt) return "scheduled";
  return now >= cycle.nextReviewAt + cycle.cadenceDays * 86_400_000 ? "overdue" : "due";
}
