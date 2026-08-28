import { defineConfig, env } from "prisma/config";

// Prisma 7: datasource URL은 schema.prisma가 아니라 여기로 옮긴다.
// Docker/프로덕션 migrate deploy가 이 파일을 읽어야 하므로, garage와 같이
// prisma/config의 env()로 DATABASE_URL을 넘긴다 (process.env 직접 참조는
// config 로더에 따라 url이 비어 "datasource.url required"로 터질 수 있음).
//
// generate만 DB에 안 붙는다 — CI/Docker 빌드에서는 DATABASE_URL 더미를 환경에 넣고 돌린다
// (apps/api/Dockerfile, .github/workflows/ci.yml). migrate는 실제 URL 필수.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --env-file=../../.env prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
