import { WS_METHODS } from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import { userScheduleActor, type ScheduleActor } from "../../scheduledTasks/Service.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteBodyOf, RouteTable } from "./routeTable.ts";

type ScheduledTaskMethod =
  | typeof WS_METHODS.scheduledTasksList
  | typeof WS_METHODS.scheduledTasksGet
  | typeof WS_METHODS.scheduledTasksCreate
  | typeof WS_METHODS.scheduledTasksUpdate
  | typeof WS_METHODS.scheduledTasksDelete
  | typeof WS_METHODS.scheduledTasksSetEnabled
  | typeof WS_METHODS.scheduledTasksRunNow
  | typeof WS_METHODS.scheduledTasksListRuns
  | typeof WS_METHODS.scheduledTasksFindRunForTurn
  | typeof WS_METHODS.scheduledTasksPreviewSchedule
  | typeof WS_METHODS.scheduledTasksResolveRun
  | typeof WS_METHODS.scheduledTasksClaimNotifications
  | typeof WS_METHODS.scheduledTasksAcknowledgeNotifications;

type Input<Method extends ScheduledTaskMethod> = Omit<RouteBodyOf<Method>, "_tag">;
type Answer<R> = Effect.Effect<unknown, { readonly message: string }, R>;
/** Checked against what the actor may see and change. */
type AsActor<Method extends ScheduledTaskMethod, R> = (
  input: Input<Method>,
  actor: ScheduleActor,
) => Answer<R>;
type Unattributed<Method extends ScheduledTaskMethod, R> = (input: Input<Method>) => Answer<R>;

/** What the routes use of the scheduled task service. `R` is what its effects need to run. */
export interface ScheduledTaskRouteService<R = never> {
  readonly list: AsActor<typeof WS_METHODS.scheduledTasksList, R>;
  readonly get: AsActor<typeof WS_METHODS.scheduledTasksGet, R>;
  readonly create: AsActor<typeof WS_METHODS.scheduledTasksCreate, R>;
  readonly update: AsActor<typeof WS_METHODS.scheduledTasksUpdate, R>;
  readonly delete: AsActor<typeof WS_METHODS.scheduledTasksDelete, R>;
  readonly setEnabled: AsActor<typeof WS_METHODS.scheduledTasksSetEnabled, R>;
  readonly runNow: AsActor<typeof WS_METHODS.scheduledTasksRunNow, R>;
  readonly listRuns: AsActor<typeof WS_METHODS.scheduledTasksListRuns, R>;
  readonly findRunForTurn: AsActor<typeof WS_METHODS.scheduledTasksFindRunForTurn, R>;
  readonly resolveRun: AsActor<typeof WS_METHODS.scheduledTasksResolveRun, R>;
  readonly previewSchedule: Unattributed<typeof WS_METHODS.scheduledTasksPreviewSchedule, R>;
  readonly claimNotifications: Unattributed<typeof WS_METHODS.scheduledTasksClaimNotifications, R>;
  readonly acknowledgeNotifications: Unattributed<
    typeof WS_METHODS.scheduledTasksAcknowledgeNotifications,
    R
  >;
}

export interface ScheduledTaskRouteDependencies<R = never> {
  readonly schedules: ScheduledTaskRouteService<R>;
  /**
   * Whether a connected desktop app shows scheduled task notifications. While
   * it does, the server hands them to it and a client that asks gets none, so
   * a notification is not shown twice.
   */
  readonly desktopShowsNotifications: () => boolean;
}

const withoutTag = <Method extends ScheduledTaskMethod>(body: RouteBodyOf<Method>) =>
  Struct.omit(body, ["_tag"]) as Input<Method>;

const answer = <R>(result: Answer<R>) =>
  result.pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));

/** Scheduled tasks, their runs and their notifications. A client acts as the user. */
export const scheduledTaskRoutes = <R = never>({
  schedules,
  desktopShowsNotifications,
}: ScheduledTaskRouteDependencies<R>): RouteTable<ScheduledTaskMethod, R> => ({
  [WS_METHODS.scheduledTasksList]: (body) =>
    answer(schedules.list(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksGet]: (body) =>
    answer(schedules.get(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksCreate]: (body) =>
    answer(schedules.create(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksUpdate]: (body) =>
    answer(schedules.update(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksDelete]: (body) =>
    answer(schedules.delete(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksSetEnabled]: (body) =>
    answer(schedules.setEnabled(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksRunNow]: (body) =>
    answer(schedules.runNow(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksListRuns]: (body) =>
    answer(schedules.listRuns(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksFindRunForTurn]: (body) =>
    answer(schedules.findRunForTurn(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksResolveRun]: (body) =>
    answer(schedules.resolveRun(withoutTag(body), userScheduleActor)),
  [WS_METHODS.scheduledTasksPreviewSchedule]: (body) =>
    answer(schedules.previewSchedule(withoutTag(body))),
  [WS_METHODS.scheduledTasksClaimNotifications]: (body) =>
    Effect.suspend(() =>
      desktopShowsNotifications()
        ? Effect.succeed({
            notifications: [],
            leaseExpiresAt: new Date().toISOString(),
            retryAt: null,
          })
        : answer(schedules.claimNotifications(withoutTag(body))),
    ),
  [WS_METHODS.scheduledTasksAcknowledgeNotifications]: (body) =>
    answer(schedules.acknowledgeNotifications(withoutTag(body))),
});
