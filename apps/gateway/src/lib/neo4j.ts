import neo4j, { type Driver, type Session } from "neo4j-driver";
import { neo4jReadUnits, neo4jWriteUnits } from "./metering.js";

let driver: Driver | null = null;

export function neo4jConfigured(): boolean {
  return Boolean(process.env.NEO4J_URI?.trim());
}

export function getNeo4jDriver(): Driver {
  if (!neo4jConfigured()) {
    throw new Error("NEO4J_URI is not configured on ModelForge");
  }
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "modelforge",
      ),
    );
  }
  return driver;
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

function isWriteCypher(cypher: string): boolean {
  return /\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b/i.test(cypher);
}

export async function runCypher<T = Record<string, unknown>>(input: {
  cypher: string;
  params?: Record<string, unknown>;
  database?: string;
}): Promise<{
  records: T[];
  kind: "read" | "write";
  billableUnits: number;
  tookMs: number;
}> {
  const kind = isWriteCypher(input.cypher) ? "write" : "read";
  const started = Date.now();
  const session: Session = getNeo4jDriver().session(
    input.database ? { database: input.database } : undefined,
  );
  try {
    const result = await session.run(input.cypher, input.params ?? {});
    const records = result.records.map((record) => record.toObject() as T);
    return {
      records,
      kind,
      billableUnits: kind === "write" ? neo4jWriteUnits() : neo4jReadUnits(),
      tookMs: Date.now() - started,
    };
  } finally {
    await session.close();
  }
}

export async function neo4jStoreStats(): Promise<{
  nodeCount: number;
  relationshipCount: number;
  storeSizeBytes: number;
  tookMs: number;
}> {
  const started = Date.now();
  const session = getNeo4jDriver().session();
  try {
    const n = await session.run("MATCH (node) RETURN count(node) AS c");
    const r = await session.run("MATCH ()-[rel]->() RETURN count(rel) AS c");
    const nodeCount = Number(n.records[0]?.get("c") ?? 0);
    const relationshipCount = Number(r.records[0]?.get("c") ?? 0);
    // Desktop/Community often block JMX store probes — estimate footprint.
    const storeSizeBytes = nodeCount * 256 + relationshipCount * 128;
    return {
      nodeCount,
      relationshipCount,
      storeSizeBytes,
      tookMs: Date.now() - started,
    };
  } finally {
    await session.close();
  }
}
