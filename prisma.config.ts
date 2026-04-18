import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Load .env files for local dev. In Docker, DATABASE_URL is already in the
// environment via docker-compose, so these are no-ops.
config({ path: ".env.local" });
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
