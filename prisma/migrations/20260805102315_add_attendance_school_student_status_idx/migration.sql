-- CreateIndex
CREATE INDEX "Attendance_schoolId_studentId_status_idx" ON "Attendance"("schoolId", "studentId", "status");
