ALTER TABLE "MeetingParticipant"
  ADD COLUMN "cameraEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "microphoneEnabled" BOOLEAN NOT NULL DEFAULT true;
