import { tool } from "@opencode-ai/plugin";
import { deployAppDefinition } from "./_deploy-app.js";

export default tool(deployAppDefinition(tool.schema));
