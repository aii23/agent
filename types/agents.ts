export type AgentType = 'MANAGER' | 'EXECUTOR'

export interface AgentListItem {
  id: string
  slug: string
  name: string
  role: string
  agentType: AgentType
}

export interface AgentDetail extends AgentListItem {
  description: string | null
  systemPrompt: string
  model: string
  maxSteps: number
  notionScope: unknown | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  delegatesTo: AgentListItem[]
  delegatedBy: AgentListItem[]
}
