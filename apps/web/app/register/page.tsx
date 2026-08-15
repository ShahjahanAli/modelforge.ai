"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertCircle, ArrowRight, Hexagon } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name, password }),
    });
    setLoading(false);
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Registration failed");
      return;
    }
    router.push("/login");
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
            <h1 className="text-lg font-semibold tracking-tight">Create account</h1>
            <p className="mt-1 text-xs text-content-muted">
              You will start on the free tier with an assigned token quota.
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              className="input"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
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
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
            <p className="mt-1.5 text-[11px] text-content-muted">Minimum 8 characters.</p>
          </div>

          {error && (
            <p className="danger-note">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <button className="btn w-full" disabled={loading}>
            {loading ? (
              "Creating…"
            ) : (
              <>
                Create account
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </button>

          <p className="text-center text-xs text-content-muted">
            Already registered?{" "}
            <Link href="/login" className="font-medium text-brand-700 hover:text-brand-600">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
