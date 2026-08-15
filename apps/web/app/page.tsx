import Link from "next/link";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { ArrowRight, Cpu, Gauge, Hexagon, Lock, Plug } from "lucide-react";
import { authOptions } from "@/lib/auth";

const capabilities = [
  {
    icon: Plug,
    title: "OpenAI-compatible",
    body: "Drop-in /v1/chat/completions with SSE streaming — point any existing SDK at your own host.",
  },
  {
    icon: Cpu,
    title: "CPU-first runtime",
    body: "llama.cpp with mmap-backed GGUF loading, a RAM-budgeted LRU pool, and continuous batching.",
  },
  {
    icon: Gauge,
    title: "Metered by default",
    body: "Per-key rate limits, monthly token quotas, and margin analytics on every request.",
  },
  {
    icon: Lock,
    title: "Isolated by design",
    body: "Engine, gateway, and control plane run as separate processes; gRPC never leaves the host.",
  },
];

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    const role = (session.user as { role?: string }).role;
    redirect(role === "ADMIN" ? "/admin/infra" : "/dashboard");
  }

  return (
    <main className="relative min-h-screen">
      <div className="app-backdrop" aria-hidden />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-6 sm:py-6">
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg border border-brand-100 bg-brand-50">
            <Hexagon className="size-4 text-brand-600" strokeWidth={2.4} aria-hidden />
          </span>
          <span className="text-sm font-semibold tracking-tight">ModelForge</span>
        </span>
        <Link href="/login" className="btn-ghost text-sm">
          Sign in
        </Link>
      </header>

      <section className="mx-auto w-full max-w-6xl px-5 pb-16 pt-8 sm:px-6 sm:pt-16">
        <p className="label-caps">ZMS Digital Solutions</p>
        <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl">
          Self-hosted LLM inference with{" "}
          <span className="bg-gradient-to-r from-brand-600 to-signal-600 bg-clip-text text-transparent">
            no proxy in the middle
          </span>
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-content-secondary sm:text-base">
          Run quantized open models on your own CPUs, expose an OpenAI-compatible API, and bill for
          it — inference engine, gateway, metering, and dashboards in one platform.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link className="btn w-full sm:w-auto" href="/register">
            Create account
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Link className="btn-secondary w-full sm:w-auto" href="/login">
            Sign in
          </Link>
        </div>

        <pre className="panel mt-10 overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-content-secondary sm:p-4 sm:text-xs">
          <code>{`from openai import OpenAI

client = OpenAI(base_url="https://your-host/v1", api_key="mf_...")
client.chat.completions.create(
    model="zms-coder-7b",
    messages=[{"role": "user", "content": "Explain mmap"}],
    stream=True,
)`}</code>
        </pre>

        <div className="mt-5 grid gap-3 sm:mt-6 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {capabilities.map((item) => (
            <article key={item.title} className="panel panel-hover p-4 sm:p-5">
              <span className="grid size-9 place-items-center rounded-lg border border-brand-100 bg-brand-50">
                <item.icon className="size-4 text-brand-600" strokeWidth={2} aria-hidden />
              </span>
              <h2 className="mt-3.5 text-sm font-semibold tracking-tight text-content-primary">
                {item.title}
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-content-secondary">{item.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
