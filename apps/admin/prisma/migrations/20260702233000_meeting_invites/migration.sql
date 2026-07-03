CREATE TABLE "MeetingInvite" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MeetingInvite_meetingId_email_key" ON "MeetingInvite"("meetingId", "email");
CREATE INDEX "MeetingInvite_email_idx" ON "MeetingInvite"("email");

ALTER TABLE "MeetingInvite" ADD CONSTRAINT "MeetingInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
