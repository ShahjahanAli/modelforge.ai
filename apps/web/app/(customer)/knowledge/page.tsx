import { prisma } from "@modelforge/db";
import { BookOpen, Trash2 } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  createKnowledgeBaseAction,
  deleteKnowledgeBaseAction,
  deleteKnowledgeDocumentAction,
  ingestKnowledgeDocumentAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const user = await requireSession();
  const bases = await prisma.knowledgeBase.findMany({
    where: user.role === "ADMIN" ? {} : { customerId: user.id },
    include: {
      documents: {
        orderBy: { createdAt: "desc" },
        include: { versions: { select: { _count: { select: { chunks: true } } } } },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Memory"
        title="Knowledge bases"
        description="Ingest documents here. Chat retrieves matching passages and answers only from those passages."
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
          <PanelHeader title="Ingest document" />
          <PanelBody>
            <form action={ingestKnowledgeDocumentAction} className="space-y-3" encType="multipart/form-data">
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
                <input className="input" name="title" placeholder="Optional when uploading a file" />
              </label>
              <label className="block">
                <span className="field-label">Paste text</span>
                <textarea className="input min-h-32" name="content" />
              </label>
              <label className="block">
                <span className="field-label">Or upload .txt / .md / .csv</span>
                <input className="input" type="file" name="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" />
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
            description="Create a knowledge base and ingest documents. Chat will then answer only from those documents."
          />
        ) : (
          <div className="space-y-6 p-4">
            {bases.map((base) => {
              const documentCount = base.documents.length;
              const chunkCount = base.documents.reduce(
                (sum, document) =>
                  sum + document.versions.reduce((inner, version) => inner + version._count.chunks, 0),
                0,
              );
              return (
                <article key={base.id} className="rounded-xl border border-line bg-surface-1">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
                    <div>
                      <h3 className="font-medium text-content-primary">{base.name}</h3>
                      <p className="mt-1 text-xs text-content-muted">
                        {base.description || "No description"} · {documentCount} document
                        {documentCount === 1 ? "" : "s"} · {chunkCount} chunks
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="info">{base.sensitivity}</Badge>
                      <form action={deleteKnowledgeBaseAction}>
                        <input type="hidden" name="knowledgeBaseId" value={base.id} />
                        <button className="btn-ghost" type="submit" title="Delete knowledge base">
                          <Trash2 className="size-4" aria-hidden />
                          Delete
                        </button>
                      </form>
                    </div>
                  </div>
                  {base.documents.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-content-muted">No documents yet. Ingest text to ground chat.</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Document</th>
                            <th>Status</th>
                            <th className="text-right">Chunks</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {base.documents.map((document) => (
                            <tr key={document.id}>
                              <td className="font-medium">{document.title}</td>
                              <td>
                                <Badge tone={document.status === "SUCCEEDED" ? "ok" : "warn"}>
                                  {document.status}
                                </Badge>
                              </td>
                              <td className="text-right font-mono">
                                {document.versions.reduce((sum, version) => sum + version._count.chunks, 0)}
                              </td>
                              <td className="text-right">
                                <form action={deleteKnowledgeDocumentAction}>
                                  <input type="hidden" name="documentId" value={document.id} />
                                  <button className="btn-ghost" type="submit" title="Delete document">
                                    <Trash2 className="size-3.5" aria-hidden />
                                  </button>
                                </form>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
