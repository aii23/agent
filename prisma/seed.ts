import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MANAGERS, EXECUTORS } from "./agents";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// ─────────────────────────────────────────────────────────────────────────────
// Agent definitions live in prisma/agents/
//
// The seed file is the source of truth: re-running `prisma db seed` will
// overwrite every field below on existing rows. If you want to tune an agent
// from the database directly, do not also edit it here — pick one home.
// ─────────────────────────────────────────────────────────────────────────────

const AGENTS = [...MANAGERS, ...EXECUTORS];

// ─────────────────────────────────────────────────────────────────────────────
// Delegation graph
//
// `managerSlug -> [agent slugs it can delegate to]`. We use `set` rather than
// `connect` when applying these so the seed is authoritative: removing a slug
// here removes the edge in the database on the next run.
// ─────────────────────────────────────────────────────────────────────────────

const DELEGATIONS: Record<string, string[]> = {
  ceo: [
    "web-search",
    "web-fetch",
    "researcher",
    "writer",
    "task-splitter",
    "x-trend-scout",
    "x-competitor-pulse",
  ],
  cpo: ["cpo-reviewer", "task-splitter", "researcher", "web-search", "web-fetch"],
  cmo: [
    "content-generator",
    "content-polisher",
    "content-planner",
    "content-validator",
    "cmo-reviewer",
    "researcher",
    "writer",
    "editor",
    "x-trend-scout",
    "x-competitor-pulse",
    "web-search",
    "web-fetch",
  ],
  cto: ["researcher", "writer", "editor", "task-splitter", "web-search", "web-fetch"],
  cfo: ["researcher", "writer", "editor", "task-splitter", "web-search", "web-fetch"],
  clo: ["researcher", "writer", "editor", "web-search", "web-fetch"],
};

// ─────────────────────────────────────────────────────────────────────────────

function assertDelegationsRefValidSlugs() {
  const known = new Set(AGENTS.map((a) => a.slug));
  for (const [manager, targets] of Object.entries(DELEGATIONS)) {
    if (!known.has(manager)) {
      throw new Error(
        `DELEGATIONS key "${manager}" is not a defined agent slug.`,
      );
    }
    for (const t of targets) {
      if (!known.has(t)) {
        throw new Error(
          `DELEGATIONS["${manager}"] references unknown agent slug "${t}".`,
        );
      }
      if (t === manager) {
        throw new Error(`Agent "${manager}" cannot delegate to itself.`);
      }
    }
  }
}

async function upsertAgents() {
  for (const { slug, tools = [], ...rest } of AGENTS) {
    await prisma.agent.upsert({
      where: { slug },
      create: { slug, tools, ...rest },
      update: { tools, ...rest },
    });
  }
}

async function wireDelegations() {
  for (const [managerSlug, targetSlugs] of Object.entries(DELEGATIONS)) {
    await prisma.agent.update({
      where: { slug: managerSlug },
      data: {
        delegatesTo: {
          set: targetSlugs.map((slug) => ({ slug })),
        },
      },
    });
  }
}

async function main() {
  assertDelegationsRefValidSlugs();
  await upsertAgents();
  await wireDelegations();

  console.log(`✓ Seeded ${AGENTS.length} agents`);
  console.log(`  managers:  ${MANAGERS.map((m) => m.slug).join(", ")}`);
  console.log(`  executors: ${EXECUTORS.map((e) => e.slug).join(", ")}`);
  console.log(
    `✓ Wired delegation for ${Object.keys(DELEGATIONS).length} managers`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
