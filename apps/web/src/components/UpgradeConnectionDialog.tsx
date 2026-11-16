import { SurfaceErrorBoundary } from "./ui/SurfaceErrorBoundary";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";

/** Loaded only for a protocol upgrade; drafts remain mounted beneath the surface. */
export interface UpgradeDialogProps {
  title: string;
  description: string;
  children: ReactNode;
  fallback: ReactNode;
}
export default function UpgradeConnectionDialog(props: UpgradeDialogProps) {
  return (
    <SurfaceErrorBoundary name="upgrade-dialog" fallback={props.fallback}>
      <Dialog open onOpenChange={() => {}}>
        <DialogPopup
          showCloseButton={false}
          bottomStickOnMobile={false}
          // Popups sit at z-[130] and portal outside the inert app tree; cover any left open.
          layerClassName="z-[135]"
          className="w-full max-w-xl overflow-y-auto break-words rounded-[1.75rem] border border-border/80 bg-card/96 p-6 shadow-2xl shadow-black/25 sm:p-8"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                Update available
              </p>
              <DialogTitle className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                {props.title}
              </DialogTitle>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-3 shadow-sm">
              <AlertTriangle className="size-5" />
            </div>
          </div>
          <DialogDescription className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {props.description}
          </DialogDescription>
          <div className="mt-5 flex flex-wrap gap-2">{props.children}</div>
        </DialogPopup>
      </Dialog>
    </SurfaceErrorBoundary>
  );
}
