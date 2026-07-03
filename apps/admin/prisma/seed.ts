import { PrismaClient, UserRank } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/passwords";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://shape_meet:shape_meet@localhost:5432/shape_meet?schema=public";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.HOST_BOOTSTRAP_EMAIL ?? "admin@shape.test";
  const password = process.env.HOST_BOOTSTRAP_PASSWORD ?? "ChangeMe123!";

  const admin = await prisma.user.upsert({
    where: { email },
    update: { rank: UserRank.ADMIN, status: "ACTIVE" },
    create: {
      username: "admin",
      email,
      passwordHash: await hashPassword(password),
      rank: UserRank.ADMIN,
      temporaryPassword: true
    }
  });

  await prisma.auditLog.create({
    data: {
      actorId: admin.id,
      action: "BOOTSTRAP_ADMIN",
      targetId: admin.id,
      metadata: { email }
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
