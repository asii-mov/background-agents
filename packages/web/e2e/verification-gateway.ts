import { permissionsForBuiltInRole } from "../../shared/src/rbac";
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
const USER_ID = "0123456789abcdef0123456789abcdef";
const NOW = 1_787_785_200_000;

const verificationUser = {
  id: USER_ID,
  name: "Verifier Admin",
  email: "verifier@example.test",
  image: null,
};

const verificationRepositories = [
  {
    id: 1001,
    fullName: "openai/skills",
    owner: "openai",
    name: "skills",
    description: "Skills repository",
    private: false,
    defaultBranch: "main",
  },
  {
    id: 1002,
    fullName: "acme/identity-service",
    owner: "acme",
    name: "identity-service",
    description: "Identity service",
    private: true,
    defaultBranch: "main",
  },
];

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
      ownerUserId: USER_ID,
      ownerTeamId: null,
      visibility: "private",
      collaborators: [],
      capabilities: {
        canRead: true,
        canCollaborate: true,
        canManageLifecycle: true,
        canDelete: true,
        canSandbox: true,
        canManageCollaborators: true,
        canChangeVisibility: true,
      },
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
              userId: USER_ID,
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

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function sendServerMessage(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(serverMessageSchema.parse(message)));
}

function sendText(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(value);
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", origin);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
    sendJson(
      response,
      {
        user: verificationUser,
        session: {
          id: "browser-verification",
          userId: USER_ID,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
      200,
      {
        "set-cookie":
          "openinspect.session_token=loopback-verification-session; Path=/; HttpOnly; SameSite=Lax",
      }
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/me/authorization") {
    sendJson(response, {
      userId: USER_ID,
      suspendedAt: null,
      role: { id: "role_builtin_administrator", key: "administrator", name: "Administrator" },
      permissions: permissionsForBuiltInRole("administrator"),
    });
    return;
  }
  if (request.method === "GET" && ["/me/teams", "/teams"].includes(url.pathname)) {
    sendJson(response, {
      teams: [],
      capabilities: { canListAllTeams: true },
      requireTeamOnCreate: false,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/keyboard-shortcuts") {
    sendJson(response, {
      shortcuts: {
        "send-prompt": { code: "Enter", primary: true, alt: false, shift: false },
        "open-command-menu": { code: "KeyK", primary: true, alt: false, shift: false },
        "new-session": { code: "KeyO", primary: true, alt: false, shift: true },
        "toggle-sidebar": { code: "Slash", primary: true, alt: false, shift: false },
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/sessions/inbox") {
    sendJson(response, {
      categories: Object.fromEntries(
        ["needs_attention", "in_progress", "finished"].map((category) => [
          category,
          { items: [], hasMore: false, nextCursor: null },
        ])
      ),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/repos") {
    sendJson(response, {
      repos: verificationRepositories,
      cached: false,
      cachedAt: new Date(NOW).toISOString(),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/environments") {
    sendJson(response, { environments: [], total: 0 });
    return;
  }
  if (request.method === "GET" && url.pathname === "/model-preferences") {
    sendJson(response, { enabledModels: ["openai/gpt-5.4"] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/model-provider-accounts") {
    sendJson(response, { accounts: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/model-provider-account-defaults") {
    sendJson(response, { defaults: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/skill-profiles") {
    sendJson(response, { profiles: [] });
    return;
  }
  if (
    request.method === "GET" &&
    (url.pathname === "/repos/openai/skills/branches" ||
      url.pathname === "/repos/acme/identity-service/branches")
  ) {
    sendJson(response, { branches: [{ name: "main" }] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/skills/resolve-preview") {
    request.resume();
    sendJson(response, { skills: [], totalBytes: 0, ignoredProfileSkillIds: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, { sessions: [], hasMore: false, nextCursor: null });
    return;
  }
  if (request.method === "POST" && url.pathname === "/sessions") {
    request.resume();
    sendJson(response, { sessionId: SESSION_ID, status: "active" }, 201);
    return;
  }
  if (request.method === "POST" && url.pathname === `/sessions/${SESSION_ID}/prompt`) {
    request.resume();
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === `/sessions/${SESSION_ID}/ws-token`) {
    request.resume();
    sendJson(response, { token: "loopback-session-token" });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}`) {
    sendJson(response, buildSnapshot());
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}/sandbox-access`) {
    sendJson(response, {
      codeServer: null,
      vnc: null,
      ttyd: { url: `${origin.origin}/terminal`, token: "loopback-terminal-token" },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}/children`) {
    sendJson(response, { children: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}/participant-profiles`) {
    sendJson(response, {
      profiles: {
        [USER_ID]: {
          userId: USER_ID,
          displayName: verificationUser.name,
          avatarUrl: null,
        },
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}/skills`) {
    sendJson(response, {
      manifestSha256: "9c".repeat(32),
      resolverVersion: 2,
      selection: { mode: "all" },
      resolvedAt: NOW,
      skills: [],
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `/sessions/${SESSION_ID}/diff`) {
    sendJson(response, {
      version: 1,
      current: {
        version: 1,
        revisionId: "revision-verification-1",
        triggerMessageId: "message-user-1",
        capturedAt: NOW + 3_500,
        repositories: [
          {
            status: "ready",
            position: 0,
            repoOwner: "acme",
            repoName: "identity-service",
            baseSha: "1".repeat(40),
            headSha: "2".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [
              {
                id: "identity-validator-ts",
                path: "src/identity/validator.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                renderState: "renderable",
              },
            ],
          },
        ],
      },
      lastError: null,
      unavailableReason: null,
    });
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname ===
      `/sessions/${SESSION_ID}/diff/revision-verification-1/files/identity-validator-ts`
  ) {
    sendText(
      response,
      "diff --git a/src/identity/validator.ts b/src/identity/validator.ts\n" +
        "index 1111111..2222222 100644\n" +
        "--- a/src/identity/validator.ts\n" +
        "+++ b/src/identity/validator.ts\n" +
        "@@ -1,3 +1,4 @@\n" +
        "-export function validate(input: string) {\n" +
        "+export function validate(input: string): boolean {\n" +
        "+  if (!input.trim()) return false;\n" +
        "   return input.length > 0;\n" +
        " }\n"
    );
    return;
  }
  if (request.method === "PATCH" && url.pathname === `/sessions/${SESSION_ID}/read-state`) {
    request.resume();
    sendJson(response, {
      readState: {
        latestMessageId: "message-assistant-live-1",
        latestMessageCreatedAt: NOW + 3_000,
        latestMessageReadAt: NOW + 4_000,
      },
    });
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
