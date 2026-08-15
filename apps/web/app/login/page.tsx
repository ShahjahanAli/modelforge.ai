"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Hexagon } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@modelforge.local");
  const [password, setPassword] = useState("demo123");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const result = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (result?.error) {
      setError("Invalid email or password");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-5 py-10 sm:py-12">
      <div className="app-backdrop" aria-hidden />

      <div className="w-full max-w-sm">
        <Link href="/" className="mb-7 flex items-center justify-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border border-brand-100 bg-brand-50">
            <Hexagon className="size-4 text-brand-600" strokeWidth={2.4} aria-hidden />
          </span>
          <span className="text-base font-semibold tracking-tight text-content-primary">
            ModelForge
          </span>
        </Link>

        <form onSubmit={onSubmit} className="panel space-y-5 p-5 sm:p-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-xs text-content-muted">
              Access your inference workspace and API keys.
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div>
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error && (
            <p className="danger-note">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <button className="btn w-full" disabled={loading}>
            {loading ? (
              "Signing in…"
            ) : (
              <>
                Sign in
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </button>

          <p className="text-center text-xs text-content-muted">
            No account?{" "}
            <Link href="/register" className="font-medium text-brand-700 hover:text-brand-600">
              Create one
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
