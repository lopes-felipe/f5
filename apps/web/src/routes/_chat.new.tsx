import { createFileRoute, useLocation } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { NewThreadLinkView } from "../components/promptLinks/NewThreadLinkView";
import { readPromptLinkDelivery } from "../components/promptLinks/promptLinkDelivery";
import { SidebarInset } from "../components/ui/sidebar";

function NewThreadLinkRouteView() {
  // The raw query: the router's parsed search would turn a numeric prompt into a number.
  const search = useLocation({ select: (location) => location.searchStr });
  const delivery = useLocation({ select: (location) => readPromptLinkDelivery(location.state) });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Prompt link" }]} />
        <div className="flex flex-1 items-start justify-center overflow-y-auto">
          <NewThreadLinkView search={search} delivery={delivery} />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/new")({
  component: NewThreadLinkRouteView,
});
