import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  serverMessageSchema,
  sessionSnapshotSchema,
  type ServerMessage,
  type SessionSnapshot,
} from "../../shared/src/types/server-messages";
import { clientMessageSchema } from "../../shared/src/types/websocket";
import { WebSocketServer, type WebSocket } from "ws";

const SESSION_ID = "session-verification";
const NOW = 1_787_785_200_000;

function loopbackOrigin(value: string | undefined): URL {
  const url = new URL(value ?? "http://127.0.0.1:3301");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENINSPECT_VERIFY_GATEWAY_URL must be an http://127.0.0.1:<port> or http://localhost:<port> origin"
    );
  }
  return url;
}

const origin = loopbackOrigin(process.env.OPENINSPECT_VERIFY_GATEWAY_URL);

function buildSnapshot(): SessionSnapshot {
  return sessionSnapshotSchema.parse({
    session: {
      id: SESSION_ID,
      title: "Harden identity validation",
      repoOwner: "acme",
      repoName: "identity-service",
      baseBranch: "main",
      branchName: "openinspect/harden-identity-validation",
      status: "active",
      sandboxStatus: "ready",
      messageCount: 1,
      createdAt: NOW,
      model: "gpt-5.4",
      reasoningEffort: "high",
      isProcessing: false,
      totalCost: 0.42,
      ttydUrl: `${origin.origin}/terminal`,
    },
    artifacts: [
      {
        id: "artifact-pr-42",
        type: "pr",
        url: "https://github.com/acme/identity-service/pull/42",
        metadata: {
          number: 42,
          lifecycleState: "open",
          isDraft: false,
          head: "openinspect/harden-identity-validation",
          base: "main",
          repoOwner: "acme",
          repoName: "identity-service",
        },
        createdAt: NOW + 4_000,
      },
    ],
    timeline: {
      events: [
        {
          eventId: "timeline-user-1",
          timelineSequence: 1,
          event: {
            type: "user_message",
            content: "Harden the identity validation and open a pull request",
            messageId: "message-user-1",
            timestamp: NOW + 1_000,
            author: {
              participantId: "participant-verifier",
              userId: "0123456789abcdef0123456789abcdef",
              name: "Verifier Admin",
            },
          },
        },
      ],
      hasMore: false,
      cursor: null,
    },
    promptQueue: [],
    spawnError: null,
  });
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendServerMessage(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(serverMessageSchema.parse(message)));
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", origin);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}`) {
    sendJson(response, buildSnapshot());
    return;
  }
  if (request.method === "GET" && url.pathname === "/terminal") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    response.end(
      "<!doctype html><html><body style='background:#111;color:#eee;font-family:monospace'>verification@openinspect:~/identity-service$ tests passed</body></html>"
    );
    return;
  }
  sendJson(
    response,
    { error: `Unhandled verification gateway route: ${request.method} ${url.pathname}` },
    501
  );
}

const server = createServer(handleHttp);
const sockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname !== `/sessions/${SESSION_ID}/ws`) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) =>
    sockets.emit("connection", webSocket)
  );
});

sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.close(4004, "Invalid JSON");
      return;
    }
    const parsed = clientMessageSchema.safeParse(message);
    if (!parsed.success) {
      socket.close(4004, "Invalid client message");
      return;
    }
    if (parsed.data.type === "subscribe") {
      sendServerMessage(socket, {
        type: "subscribed",
        ...buildSnapshot(),
        participantId: "participant-verifier",
        participant: {
          participantId: "participant-verifier",
          userId: "0123456789abcdef0123456789abcdef",
          name: "Verifier Admin",
        },
      });
      sendServerMessage(socket, {
        type: "presence_sync",
        participants: [
          {
            participantId: "participant-verifier",
            userId: "0123456789abcdef0123456789abcdef",
            name: "Verifier Admin",
            status: "active",
            lastSeen: NOW,
          },
        ],
      });
      sendServerMessage(socket, {
        type: "sandbox_event",
        event: {
          type: "token",
          sandboxId: "sandbox-verification",
          messageId: "message-assistant-live-1",
          timestamp: NOW + 2_000,
          content: "Validation is hardened and pull request #42 is ready for review.",
        },
      });
      sendServerMessage(socket, {
        type: "sandbox_event",
        event: {
          type: "execution_complete",
          sandboxId: "sandbox-verification",
          messageId: "message-assistant-live-1",
          timestamp: NOW + 3_000,
          success: true,
        },
      });
      return;
    }
    if (parsed.data.type === "ping") {
      sendServerMessage(socket, { type: "pong", timestamp: Date.now() });
    }
  });
});

server.listen(Number(origin.port), origin.hostname, () => {
  process.stdout.write(`OpenInspect verification gateway listening on ${origin.origin}\n`);
});

function close(): void {
  for (const socket of sockets.clients) socket.close(1001, "Verifier stopping");
  sockets.close(() => server.close(() => process.exit(0)));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
