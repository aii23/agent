import { AgentType } from "@prisma/client";

export type AgentSeed = {
  slug: string;
  name: string;
  role: string;
  description: string;
  agentType: AgentType;
  model: string;
  maxSteps?: number;
  systemPrompt: string;
  tools?: string[];
};
