import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";

export const dynamic = "force-dynamic";

interface EngineHealth {
  healthy?: boolean;
  total_ram_mb?: number;
  used_ram_mb?: number;
  loaded_model_count?: number;
}

interface EngineModels {
  models?: Array<{ model_id: string; ram_used_mb: number; active_requests: number }>;
}

/** Poll target for the infra page so long model loads can report live state. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if ((session?.user as { role?: string } | undefined)?.role !== "ADMIN") {
    return NextResponse.json(
      { error: { type: "authentication_error", message: "Admin session required" } },
      { status: 401 },
    );
  }

  const [health, loaded] = await Promise.all([
    gatewayFetch("/internal/engine/health").catch(() => ({ healthy: false }) as EngineHealth),
    gatewayFetch("/internal/engine/models").catch(() => ({ models: [] }) as EngineModels),
  ]);

  const models = (loaded as EngineModels).models ?? [];
  const engine = health as EngineHealth;

  return NextResponse.json(
    {
      healthy: engine.healthy ?? false,
      totalRamMb: engine.total_ram_mb ?? 0,
      usedRamMb: engine.used_ram_mb ?? 0,
      resident: models.map((model) => ({
        modelId: model.model_id,
        ramUsedMb: model.ram_used_mb,
        activeRequests: model.active_requests,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
