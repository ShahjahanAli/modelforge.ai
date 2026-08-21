import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { KeyRound } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { CreateKeyForm } from "@/components/CreateKeyForm";
import { ExistingKeyCopy } from "@/components/CopyApiKey";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { revokeKeyAction } from "./actions";

export default async function KeysPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const customerId = (session.user as { id: string }).id;
  const keys = await prisma.apiKey.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
  });

  const activeCount = keys.filter((k) => !k.revokedAt).length;

  return (
    <>
      <PageHeader
        eyebrow="Credentials"
        title="API keys"
        description="Bearer tokens for the OpenAI-compatible gateway. Rotate regularly and scope one key per deployment (e.g. Anusandhan)."
        actions={
          <Badge tone={activeCount > 0 ? "ok" : "neutral"} dot>
            {activeCount} active
          </Badge>
        }
      />

      <CreateKeyForm />

      <Panel>
        <PanelHeader
          title="Existing keys"
          description={`${keys.length} total · Copy full key if this browser still remembers it; otherwise copy the prefix or generate a new key`}
        />
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Generate your first key above to start calling the inference gateway."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Label</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <span className="mono-chip">{key.keyPrefix}••••••••</span>
                    </td>
                    <td className="text-content-primary">{key.label ?? "—"}</td>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {key.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td>
                      <Badge tone={key.revokedAt ? "danger" : "ok"} dot>
                        {key.revokedAt ? "revoked" : "active"}
                      </Badge>
                    </td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-2">
                        {!key.revokedAt && (
                          <ExistingKeyCopy keyId={key.id} keyPrefix={key.keyPrefix} />
                        )}
                        {!key.revokedAt && (
                          <form action={revokeKeyAction} className="inline-flex">
                            <input type="hidden" name="id" value={key.id} />
                            <button className="btn-danger" type="submit">
                              Revoke
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
