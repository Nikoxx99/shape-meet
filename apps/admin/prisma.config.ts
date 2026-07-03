import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://shape_meet:shape_meet@localhost:5432/shape_meet?schema=public"
  }
});
