import { AuthForm } from "@/components/auth-form";
import { signup } from "../actions";

export default function SignupPage() {
  return <AuthForm mode="signup" action={signup} />;
}
