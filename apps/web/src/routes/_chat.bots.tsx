import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/bots")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: {}, replace: true });
  },
});
