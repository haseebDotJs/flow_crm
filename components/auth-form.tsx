"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Loader2, Workflow } from "lucide-react";
import type { AuthState } from "@/app/(auth)/actions";

export function AuthForm({
  mode,
  action,
}: {
  mode: "login" | "signup";
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const isLogin = mode === "login";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold text-slate-900">
          <Workflow className="h-6 w-6 text-indigo-600" /> FlowCRM
        </div>
        <form action={formAction} className="card space-y-4 p-6">
          <div>
            <h1 className="text-lg font-semibold">{isLogin ? "Welcome back" : "Create your account"}</h1>
            <p className="text-sm text-slate-500">
              {isLogin ? "Log in to your CRM." : "Start managing your pipeline."}
            </p>
          </div>
          {!isLogin && (
            <div>
              <label className="label" htmlFor="full_name">Full name</label>
              <input id="full_name" name="full_name" className="input" autoComplete="name" required />
            </div>
          )}
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" className="input" autoComplete="email" required />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={8}
              required
            />
          </div>
          {state.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
          {state.message && <p role="status" className="text-sm text-emerald-700">{state.message}</p>}
          <button type="submit" className="btn-primary w-full" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLogin ? "Log in" : "Sign up"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          {isLogin ? "No account yet? " : "Already have an account? "}
          <Link href={isLogin ? "/signup" : "/login"} className="font-medium text-indigo-600 hover:underline">
            {isLogin ? "Sign up" : "Log in"}
          </Link>
        </p>
      </div>
    </div>
  );
}
