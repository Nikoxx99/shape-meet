CREATE TYPE "IdentityDeliveryStatus" AS ENUM ('PENDING', 'READY', 'PUSHED', 'REVOKED');

ALTER TABLE "HostIdentity"
  ADD COLUMN "artifactSha256" TEXT,
  ADD COLUMN "artifactSizeBytes" INTEGER,
  ADD COLUMN "deliveryStatus" "IdentityDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "publishedAt" TIMESTAMP(3);

UPDATE "HostIdentity"
SET "deliveryStatus" = CASE
  WHEN "status" = 'REVOKED' THEN 'REVOKED'::"IdentityDeliveryStatus"
  WHEN "status" = 'AVAILABLE' AND "artifactUri" IS NOT NULL THEN 'READY'::"IdentityDeliveryStatus"
  ELSE 'PENDING'::"IdentityDeliveryStatus"
END;

CREATE INDEX "HostIdentity_status_deliveryStatus_idx" ON "HostIdentity"("status", "deliveryStatus");
