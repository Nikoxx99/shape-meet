import type { IdentityDeliveryStatus, IdentityStatus } from "@prisma/client";

export interface IdentityArtifactIntegrityInput {
  artifactUri?: string | null;
  artifactSha256?: string | null;
  artifactSizeBytes?: number | null;
}

export interface IdentityDeliveryStatusInput extends IdentityArtifactIntegrityInput {
  status: IdentityStatus;
  currentDeliveryStatus?: IdentityDeliveryStatus | null;
}

export function hasPublishableArtifact(input: IdentityArtifactIntegrityInput) {
  return Boolean(
    input.artifactUri?.trim() &&
      input.artifactSha256?.trim().match(/^[a-f0-9]{64}$/i) &&
      input.artifactSizeBytes &&
      input.artifactSizeBytes > 0,
  );
}

export function deliveryStatusForIdentity(
  input: IdentityDeliveryStatusInput,
): IdentityDeliveryStatus {
  if (input.status === "REVOKED") return "REVOKED";
  if (input.status !== "AVAILABLE" || !hasPublishableArtifact(input)) {
    return "PENDING";
  }

  return input.currentDeliveryStatus === "PUSHED" ? "PUSHED" : "READY";
}

export function artifactReadinessError() {
  return "El rostro debe estar disponible y tener artefacto, SHA256 y tamaño antes de publicarse.";
}
