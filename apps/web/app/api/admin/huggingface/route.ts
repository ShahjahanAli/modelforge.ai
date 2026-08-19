import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";
import { writeAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function adminUser(): Promise<{ id: string } | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; role?: string } | undefined;
  return user?.role === "ADMIN" && user.id ? { id: user.id } : null;
}

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Hugging Face request failed" },
    { status: 502 },
  );
}

export async function GET(request: Request) {
  if (!(await adminUser())) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  try {
    if (action === "search") {
      const q = url.searchParams.get("q") ?? "";
      return NextResponse.json(
        await gatewayFetch(`/internal/huggingface/search?q=${encodeURIComponent(q)}&limit=24`),
      );
    }
    if (action === "files") {
      const repo = url.searchParams.get("repo") ?? "";
      return NextResponse.json(
        await gatewayFetch(`/internal/huggingface/files?repo=${encodeURIComponent(repo)}`),
      );
    }
    if (action === "status") {
      const id = url.searchParams.get("id");
      return NextResponse.json(
        await gatewayFetch(
          id ? `/internal/huggingface/downloads/${encodeURIComponent(id)}` : "/internal/huggingface/downloads",
        ),
      );
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const admin = await adminUser();
  if (!admin) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  try {
    const input = (await request.json()) as { repoId?: string; filePath?: string; retryId?: string };
    const download = input.retryId
      ? ((await gatewayFetch(`/internal/huggingface/downloads/${encodeURIComponent(input.retryId)}/retry`, {
          method: "POST",
          body: "{}",
        })) as { id: string })
      : ((await gatewayFetch("/internal/huggingface/downloads", {
          method: "POST",
          body: JSON.stringify(input),
        })) as { id: string });
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: input.retryId ? "model.huggingface_download_retried" : "model.huggingface_download_started",
      resourceType: "HuggingFaceDownload",
      resourceId: download.id,
      metadata: { repoId: input.repoId ?? null, filePath: input.filePath ?? null },
    });
    return NextResponse.json(
      download,
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const admin = await adminUser();
  if (!admin) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const result = (await gatewayFetch(`/internal/huggingface/downloads/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })) as { cancelled?: boolean; removed?: boolean };
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: result.removed
        ? "model.huggingface_download_history_removed"
        : "model.huggingface_download_cancelled",
      resourceType: "HuggingFaceDownload",
      resourceId: id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
