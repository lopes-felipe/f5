import { createFileRoute } from "@tanstack/react-router";

import { ChatIndexRouteView } from "../components/home/ChatIndexRouteView";

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
