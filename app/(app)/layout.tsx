import { redirect } from "next/navigation";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { VoiceAssistant } from "@/components/voice-assistant";
import { Sidebar } from "@/components/sidebar";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", data.user.id)
    .maybeSingle();
  const name = profile?.full_name || data.user.email || "Account";

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar userName={name} role={profile?.role === "admin" ? "admin" : "member"} />
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      <RealtimeRefresh />
      <VoiceAssistant />
    </div>
  );
}
