import { Schema } from "effect";

/**
 * Workflow actors (authors, reviewers, investigators) are addressed by a
 * participant id. An actor's letter is its position in the roster, which is
 * frozen when the workflow is created.
 */
export const WORKFLOW_PARTICIPANT_IDS = ["a", "b", "c", "d", "e", "f"] as const;
export const WorkflowParticipantId = Schema.Literals(WORKFLOW_PARTICIPANT_IDS);
export type WorkflowParticipantId = typeof WorkflowParticipantId.Type;

/** Every workflow type keeps at least two actors. */
export const WORKFLOW_MIN_PARTICIPANTS = 2;
/** Full-mesh cross-review types: Feature, Document and Investigation. */
export const WORKFLOW_MESH_MAX_PARTICIPANTS = 4;
/** Independent review types: Code Review and Upstream port review. */
export const WORKFLOW_REVIEW_MAX_PARTICIPANTS = 6;
/** Actors beyond the stored A/B pair, for the largest type. */
export const WORKFLOW_MAX_ADDITIONAL_PARTICIPANTS =
  WORKFLOW_REVIEW_MAX_PARTICIPANTS - WORKFLOW_MIN_PARTICIPANTS;
