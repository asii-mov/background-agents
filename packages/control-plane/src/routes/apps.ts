import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";

/** Agent-deployed internal apps: the sandbox deploy route, the directory, takedown and holds. */
export const appRoutes = new Hono<ControlPlaneHonoEnv>();
