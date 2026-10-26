import { Schema } from "effect";
import type { NextTurnQueueError } from "./nextTurnQueue/Errors.ts";
export class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()(
  "RouteRequestError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {}

export function mapNextTurnQueueRouteError(error: NextTurnQueueError): RouteRequestError {
  return new RouteRequestError({ message: error.message, code: error._tag });
}
