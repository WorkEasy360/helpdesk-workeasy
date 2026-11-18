-- The workspace assistant is always on, so the per-organization switch is gone.
-- `assistantDailyLimit` stays: it is a spend guard (0 = no limit), never a way to
-- switch the assistant off.
ALTER TABLE "ai_settings" DROP COLUMN "assistantEnabled";
