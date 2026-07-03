ALTER TABLE "MeetingParticipant" ADD COLUMN "email" TEXT;
CREATE INDEX "MeetingParticipant_email_idx" ON "MeetingParticipant"("email");
