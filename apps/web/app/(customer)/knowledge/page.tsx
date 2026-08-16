import { prisma } from "@modelforge/db";
import { BookOpen } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  createKnowledgeBaseAction,
  ingestKnowledgeDocumentAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const user = await requireSession();
  const bases = await prisma.knowledgeBase.findMany({
    where: user.role === "ADMIN" ? {} : { customerId: user.id },
    include: { documents: true },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Memory"
        title="Knowledge bases"
        description="Tenant-scoped documents, chunking, embeddings, and retrieval with cost attribution."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Create knowledge base" />
          <PanelBody>
            <form action={createKnowledgeBaseAction} className="space-y-3">
              <label className="block">
                <span className="field-label">Name</span>
                <input className="input" name="name" required />
              </label>
              <label className="block">
                <span className="field-label">Description</span>
                <input className="input" name="description" />
              </label>
              <button className="btn" type="submit">
                Create
              </button>
            </form>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Ingest text document" />
          <PanelBody>
            <form action={ingestKnowledgeDocumentAction} className="space-y-3">
              <label className="block">
                <span className="field-label">Knowledge base</span>
                <select className="input" name="knowledgeBaseId" required>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">Title</span>
                <input className="input" name="title" required />
              </label>
              <label className="block">
                <span className="field-label">Content</span>
                <textarea className="input min-h-32" name="content" required />
              </label>
              <button className="btn" type="submit" disabled={bases.length === 0}>
                Ingest
              </button>
            </form>
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Your knowledge bases" actions={<Badge tone="neutral">{bases.length}</Badge>} />
        {bases.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No knowledge bases"
            description="Create a knowledge base to ingest documents for grounded completions."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sensitivity</th>
                  <th className="text-right">Documents</th>
                  <th className="text-right">Retention</th>
                </tr>
              </thead>
              <tbody>
                {bases.map((base) => (
                  <tr key={base.id}>
                    <td className="font-medium">{base.name}</td>
                    <td>
                      <Badge tone="info">{base.sensitivity}</Badge>
                    </td>
                    <td className="text-right font-mono">{base.documents.length}</td>
                    <td className="text-right font-mono">{base.retentionDays}d</td>
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
