"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSymphony } from "@/components/symphony/context";
import { cn } from "@/lib/utils";

export function InboxDialog() {
        const { inboxOpen, setInboxOpen, inbox, markInboxRead, selectConversation } = useSymphony();

  return (
    <Dialog open={inboxOpen} onOpenChange={setInboxOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Inbox</DialogTitle>
        </DialogHeader>
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {inbox.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">Quiet for now</p>}
          {inbox.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  markInboxRead(item.id);
                  if (item.conversationId) selectConversation(item.conversationId);
                  setInboxOpen(false);
                }}
                className={cn(
                  "w-full rounded-xl px-3 py-2.5 text-left",
                  item.read ? "bg-transparent hover:bg-muted/40" : "bg-muted/50 hover:bg-muted",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-medium">{item.title}</p>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{item.at}</span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.detail}</p>
                {!item.read && (
                  <span
                    className={cn(
                      "mt-2 inline-block size-1.5 rounded-full",
                      item.severity === "failure" ? "bg-foreground" : "bg-muted-foreground",
                    )}
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
