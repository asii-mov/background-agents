import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";

/** App data: summaries, secrets, migration approvals, restores, classification and inventory. */
export const appDataRoutes = new Hono<ControlPlaneHonoEnv>();
