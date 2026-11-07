import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";

/** Stack policy preview and export, stack inventory, and sandbox stack observations. */
export const stackPolicyRoutes = new Hono<ControlPlaneHonoEnv>();
