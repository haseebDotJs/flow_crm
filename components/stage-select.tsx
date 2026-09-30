"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTaskStatus, updateOpportunityStage } from "@/app/(app)/actions";
import { STAGES, STAGE_LABELS, type Stage } from "@/types";

export function StageSelect({ id, stage }: { id: string; stage: Stage }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <select
      aria-label="Change stage"
      className="input !py-1 text-xs"
      value={stage}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        start(async () => {
          const res = await updateOpportunityStage(id, next);
          if (res.ok) {
            toast.success(`Moved to ${STAGE_LABELS[next as Stage]}`);
            router.refresh();
          } else {
            toast.error(res.error);
          }
        });
      }}
    >
      {STAGES.map((s) => (
        <option key={s} value={s}>{STAGE_LABELS[s]}</option>
      ))}
    </select>
  );
}

export function TaskActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (status !== "pending") return null;

  const run = (next: "completed" | "cancelled") =>
    start(async () => {
      const res = await setTaskStatus(id, next);
      if (res.ok) {
        toast.success(next === "completed" ? "Task completed" : "Task cancelled");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <div className="flex gap-2">
      <button className="btn-secondary !px-2.5 !py-1 text-xs" disabled={pending} onClick={() => run("completed")}>
        Complete
      </button>
      <button className="btn-danger !px-2.5 !py-1 text-xs" disabled={pending} onClick={() => run("cancelled")}>
        Cancel
      </button>
    </div>
  );
}
