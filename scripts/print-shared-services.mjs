#!/usr/bin/env node
/**
 * Prints ModelForge shared-service endpoints from .env (no Docker required).
 * Local Neo4j: use Neo4j Desktop. Ubuntu: apt package + systemd.
 */
import net from "node:net";

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

function probe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

function parseHostPort(endpoint, defaultPort) {
  const raw = String(endpoint || "").replace(/^https?:\/\//, "");
  const [host, portPart] = raw.split(":");
  return { host: host || "localhost", port: Number(portPart || defaultPort) };
}

const neo4jUri = env("NEO4J_URI", "bolt://localhost:7687");
const neo4jPort = Number(neo4jUri.match(/:(\d+)/)?.[1] ?? 7687);
const neo4jHost = neo4jUri.replace(/^bolt:\/\//, "").split(":")[0] || "localhost";
const minio = parseHostPort(env("MINIO_ENDPOINT", "localhost:9010"), 9010);

const neoUp = await probe(neo4jHost, neo4jPort);
const minioUp = await probe(minio.host, minio.port);

console.log(
  JSON.stringify(
    {
      provider: "modelforge",
      clients: ["anusandhan"],
      localDev: "pnpm dev (Neo4j Desktop on Windows/Mac)",
      ubuntuServer: "apt install neo4j + systemctl enable --now neo4j",
      neo4j: {
        uri: neo4jUri,
        user: env("NEO4J_USER", "neo4j"),
        reachable: neoUp,
      },
      minio: {
        endpoint: env("MINIO_ENDPOINT", "localhost:9010"),
        bucket: env("MINIO_BUCKET", "modelforge-audio"),
        reachable: minioUp,
      },
      gateway: env("GATEWAY_INTERNAL_URL", `http://localhost:${env("GATEWAY_PORT", "9000")}`),
    },
    null,
    2,
  ),
);
