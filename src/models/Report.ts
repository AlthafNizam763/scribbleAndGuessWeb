import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { INPUT_LIMITS } from '@/constants/game.constants';

/**
 * A player report (brief section 44).
 *
 * Nothing in the API ever reads these back to a player. There is no admin
 * panel in this project (brief section 63), so reports accumulate for
 * out-of-band review; the only thing the game itself does with them is count
 * them, so a flood of reports against one account can be spotted later.
 *
 * Exposing a report — even to the reporter — would turn the feature into a
 * harassment channel of its own, so no route selects from this collection.
 */

const reportSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reporterUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, trim: true, maxlength: INPUT_LIMITS.maxReportLength },
    /** Context for a reviewer: what was on screen when the report was filed. */
    gameId: { type: Schema.Types.ObjectId, ref: 'Game', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'reports' },
);

// One report per reporter per target per room: re-reporting the same player in
// the same room is a no-op rather than a way to inflate a count.
reportSchema.index(
  { roomId: 1, reportedUserId: 1, reporterUserId: 1 },
  { unique: true },
);
reportSchema.index({ reportedUserId: 1, createdAt: -1 });

export type ReportDocument = InferSchemaType<typeof reportSchema> & { _id: Types.ObjectId };

export const Report: Model<ReportDocument> =
  (models.Report as Model<ReportDocument>) ?? model<ReportDocument>('Report', reportSchema);
