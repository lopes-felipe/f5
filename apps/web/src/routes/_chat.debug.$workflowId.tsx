import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/debug/$workflowId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/investigation/$workflowId",
      params: { workflowId: params.workflowId },
    });
  },
});
