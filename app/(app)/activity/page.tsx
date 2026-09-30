import { ActivityList } from "@/components/activity-list";
import { EmptyState, ErrorState } from "@/components/states";
import { createClient } from "@/lib/supabase/server";
import type { ActivityEntry } from "@/types";

export const metadata = { title: "Activity · FlowCRM" };

const LIMIT = 100;

export default async function ActivityPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) return <ErrorState message={`Could not load activity: ${error.message}`} />;
  const entries = (data ?? []) as ActivityEntry[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-slate-500">
          A record of changes to your contacts, deals and tasks, including those made by the Voice AI and automation.
        </p>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No activity yet" hint="Changes you make (or the Voice AI makes) will appear here." />
      ) : (
        <section className="card">
          <ActivityList entries={entries} />
          {entries.length === LIMIT && (
            <p className="border-t border-slate-100 px-4 py-3 text-center text-xs text-slate-400">
              Showing the latest {LIMIT} entries
            </p>
          )}
        </section>
      )}
    </div>
  );
}
