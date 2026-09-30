import { redirect } from "next/navigation";

// The proxy redirects signed-in users to /dashboard; everyone else lands here.
export default function Home() {
  redirect("/login");
}
