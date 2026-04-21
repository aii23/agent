import { AgentSeed } from "../types";
import { CONTENT_EXECUTORS } from "./content";
import { PLANNING_EXECUTORS } from "./planning";
import { RESEARCH_EXECUTORS } from "./research";
import { REVIEWER_EXECUTORS } from "./reviewers";
import { WRITING_EXECUTORS } from "./writing";
import { X_INTELLIGENCE_EXECUTORS } from "./x-intelligence";

export const EXECUTORS: AgentSeed[] = [
  ...CONTENT_EXECUTORS,
  ...REVIEWER_EXECUTORS,
  ...RESEARCH_EXECUTORS,
  ...WRITING_EXECUTORS,
  ...PLANNING_EXECUTORS,
  ...X_INTELLIGENCE_EXECUTORS,
];
